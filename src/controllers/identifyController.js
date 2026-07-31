// this is where all the identity reconciliation logic actually lives
// there are 4 situations that can happen when someone hits /identify and I handle each one:
//   1. totally new person — no matches at all → create a fresh primary
//   2. both fields are already covered somewhere in the group → nothing to do, just return
//   3. one group matches but at least one field is genuinely new → add a secondary
//   4. the request links two completely separate primaries → merge them, older one wins

const prisma = require("../db");

// takes the primary contact and everyone linked to it, and builds the response shape
// primary's email and phone go first, then everyone else's — deduped
function buildResponse(primary, all) {
    const emails = [];
    if (primary.email) emails.push(primary.email);
    for (const c of all) {
        // skip the primary itself and skip duplicates
        if (c.id !== primary.id && c.email && !emails.includes(c.email)) {
            emails.push(c.email);
        }
    }

    const phoneNumbers = [];
    if (primary.phoneNumber) phoneNumbers.push(primary.phoneNumber);
    for (const c of all) {
        if (
            c.id !== primary.id &&
            c.phoneNumber &&
            !phoneNumbers.includes(c.phoneNumber)
        ) {
            phoneNumbers.push(c.phoneNumber);
        }
    }

    // everyone in the group except the primary
    const secondaryContactIds = all
        .filter((c) => c.id !== primary.id)
        .map((c) => c.id);

    return {
        contact: {
            primaryContactId: primary.id,
            emails,
            phoneNumbers,
            secondaryContactIds,
        },
    };
}

// grab the primary + all its linked secondaries in one shot
// I always filter out soft-deleted rows so they don't show up in responses
async function fetchGroup(primaryId) {
    const all = await prisma.contact.findMany({
        where: {
            OR: [{ id: primaryId }, { linkedId: primaryId }],
            deletedAt: null,
        },
        orderBy: { createdAt: "asc" },
    });

    const primary = all.find((c) => c.id === primaryId);
    return { primary, all };
}

// checks whether an incoming request actually brings anything new to a group
//
// the key insight here: I'm NOT asking "does a single row have both fields at once"
// I'm asking "is each field already present somewhere in the group, even across
// different rows?" — that's the right question because a group is a collection of
// contacts, and if the email is already known AND the phone is already known (even
// on separate rows), recording them together on a new row adds zero new information
//
// returns true when at least one field is genuinely absent from the group,
// meaning we actually need to create a new secondary
function isNewInformation(email, phoneNumber, group) {
    const emailCovered = !email || group.some((c) => c.email === email);
    const phoneCovered = !phoneNumber || group.some((c) => c.phoneNumber === phoneNumber);
    // if either field is NOT covered, the request introduces something new
    return !emailCovered || !phoneCovered;
}

async function identify(req, res) {
    // need at least one of these to do anything useful
    const { email = null, phoneNumber = null } = req.body ?? {};

    if (!email && !phoneNumber) {
        return res.status(400).json({
            error: "At least one of email or phoneNumber must be provided.",
        });
    }

    // search for any existing contact that matches on email OR phone
    // only build the OR conditions for fields that were actually provided
    const matchConditions = [];
    if (email) matchConditions.push({ email });
    if (phoneNumber) matchConditions.push({ phoneNumber });

    const matchedContacts = await prisma.contact.findMany({
        where: {
            OR: matchConditions,
            deletedAt: null,
        },
        orderBy: { createdAt: "asc" },
    });

    // --- CASE 1: nobody in the DB has this email or phone ---
    // completely new identity, so I create a fresh primary and we're done
    if (matchedContacts.length === 0) {
        const newContact = await prisma.contact.create({
            data: {
                email,
                phoneNumber,
                linkedId: null,
                linkPrecedence: "primary",
            },
        });

        return res.status(200).json(
            buildResponse(newContact, [newContact])
        );
    }

    // the matched contacts might be secondaries themselves, so I need to find
    // the actual root primary for each one — that's what linkedId points to
    const primaryIdSet = new Set();
    for (const c of matchedContacts) {
        if (c.linkPrecedence === "primary") {
            primaryIdSet.add(c.id);
        } else {
            // secondary contact — its linkedId is the primary I actually care about
            primaryIdSet.add(c.linkedId);
        }
    }

    const primaryIds = Array.from(primaryIdSet);

    // everything matched back to exactly one primary group
    if (primaryIds.length === 1) {
        const [primaryId] = primaryIds;
        const { primary, all } = await fetchGroup(primaryId);

        // --- CASE 2 or CASE 3 ---
        // use isNewInformation to decide: does this request add anything the group
        // doesn't already know about? checking field-by-field across all rows,
        // not requiring both fields to live on the same single row
        if (!isNewInformation(email, phoneNumber, all)) {
            // --- CASE 2: both fields are already covered somewhere in the group ---
            // nothing new, so just hand back the current state
            return res.status(200).json(buildResponse(primary, all));
        }

        // --- CASE 3: at least one field is genuinely new to this group ---
        // the person is already known but showed up with new info this time,
        // so I add a secondary that ties the new data back to their primary
        await prisma.contact.create({
            data: {
                email,
                phoneNumber,
                linkedId: primaryId,
                linkPrecedence: "secondary",
            },
        });

        // re-fetch so the new secondary shows up in the response
        const updated = await fetchGroup(primaryId);
        return res
            .status(200)
            .json(buildResponse(updated.primary, updated.all));
    }

    // --- CASE 4: two separate primary groups are connected by this request ---
    // e.g. email matches group A and phone matches group B — they're the same person
    // I need to pick one winner (the older one) and fold the other into it

    // sort by createdAt so index 0 is always the oldest
    const primaries = await prisma.contact.findMany({
        where: { id: { in: primaryIds }, deletedAt: null },
        orderBy: { createdAt: "asc" },
    });

    const [oldestPrimary, ...newerPrimaries] = primaries;
    const winnerPrimaryId = oldestPrimary.id;
    const newerPrimaryIds = newerPrimaries.map((p) => p.id);

    // doing this in a transaction so the demote + re-link happen atomically
    // if anything fails midway I don't want a half-merged state in the DB
    await prisma.$transaction(async (tx) => {
        // turn the newer primaries into secondaries pointing at the winner
        await tx.contact.updateMany({
            where: { id: { in: newerPrimaryIds } },
            data: {
                linkPrecedence: "secondary",
                linkedId: winnerPrimaryId,
            },
        });

        // any secondaries that were already under the demoted primaries need
        // to be re-pointed to the winner too, otherwise they'd be orphaned
        await tx.contact.updateMany({
            where: {
                linkedId: { in: newerPrimaryIds },
                deletedAt: null,
            },
            data: { linkedId: winnerPrimaryId },
        });
    });

    // re-fetch the now-unified group and apply the same isNewInformation check
    // same logic as Case 3 — the email and phone might already be covered across
    // different rows (which is what triggered the merge), so no new row needed then
    const { primary: winnerPrimary, all: mergedAll } =
        await fetchGroup(winnerPrimaryId);

    if (isNewInformation(email, phoneNumber, mergedAll)) {
        // at least one field isn't in the merged group yet — add a secondary for it
        await prisma.contact.create({
            data: {
                email,
                phoneNumber,
                linkedId: winnerPrimaryId,
                linkPrecedence: "secondary",
            },
        });
    }

    // one last fetch to make sure everything including any newly created secondary is in there
    const finalGroup = await fetchGroup(winnerPrimaryId);
    return res
        .status(200)
        .json(buildResponse(finalGroup.primary, finalGroup.all));
}

module.exports = { identify };
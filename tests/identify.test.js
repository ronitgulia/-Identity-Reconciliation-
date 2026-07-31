// running these against the real SQLite DB, not mocking anything
// so make sure you've run the migration before running tests:
//   npx prisma migrate dev --name init
//
// each test wipes the Contact table first so they don't interfere with each other
// I'm using node's built-in http module instead of supertest to keep dependencies minimal

const http = require("http");
const app = require("../src/index");
const prisma = require("../src/db");

// small helper so I'm not writing raw http.request boilerplate in every test
// sends a POST with a JSON body and gives back { status, body }
function post(server, path, payload) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const { address, port } = server.address();
        const options = {
            hostname: address === "::" ? "127.0.0.1" : address,
            port,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
            },
        };

        const req = http.request(options, (res) => {
            let raw = "";
            res.on("data", (chunk) => (raw += chunk));
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(raw) });
                } catch {
                    resolve({ status: res.statusCode, body: raw });
                }
            });
        });

        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

let server;

beforeAll((done) => {
    // pass 0 so the OS picks a free port â€” avoids conflicts if something else is on 3000
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", done);
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
});

// clean slate before every single test
beforeEach(async () => {
    await prisma.contact.deleteMany({});
});

// --- validation ---
// the endpoint should reject requests where both fields are missing or null
describe("Validation", () => {
    test("returns 400 when both email and phoneNumber are missing", async () => {
        const { status, body } = await post(server, "/identify", {});
        expect(status).toBe(400);
        expect(body).toHaveProperty("error");
    });

    test("returns 400 when body has both fields explicitly null", async () => {
        const { status, body } = await post(server, "/identify", {
            email: null,
            phoneNumber: null,
        });
        expect(status).toBe(400);
        expect(body).toHaveProperty("error");
    });
});

// --- case 1: no match ---
// nothing in the DB matches â†’ brand new primary should be created
describe("Case 1 â€“ No Match", () => {
    test("creates a new primary contact and returns it", async () => {
        const { status, body } = await post(server, "/identify", {
            email: "lorraine@hillvalley.edu",
            phoneNumber: "123456",
        });

        expect(status).toBe(200);
        const { contact } = body;
        expect(contact.primaryContactId).toBeGreaterThan(0);
        expect(contact.emails).toEqual(["lorraine@hillvalley.edu"]);
        expect(contact.phoneNumbers).toEqual(["123456"]);
        expect(contact.secondaryContactIds).toEqual([]);

        // also double-check the DB directly â€” should be exactly 1 row, marked as primary
        const rows = await prisma.contact.findMany({});
        expect(rows).toHaveLength(1);
        expect(rows[0].linkPrecedence).toBe("primary");
        expect(rows[0].linkedId).toBeNull();
    });

    test("works with only email provided", async () => {
        const { status, body } = await post(server, "/identify", {
            email: "only@email.com",
        });
        expect(status).toBe(200);
        expect(body.contact.emails).toContain("only@email.com");
        expect(body.contact.phoneNumbers).toEqual([]);
    });

    test("works with only phoneNumber provided", async () => {
        const { status, body } = await post(server, "/identify", {
            phoneNumber: "9999",
        });
        expect(status).toBe(200);
        expect(body.contact.phoneNumbers).toContain("9999");
        expect(body.contact.emails).toEqual([]);
    });
});

// --- case 2: exact match ---
// the exact email+phone combo already exists â†’ return it, don't write anything
describe("Case 2 â€“ Exact Match", () => {
    test("does not create a new contact and returns consolidated info", async () => {
        await prisma.contact.create({
            data: {
                email: "mcfly@hillvalley.edu",
                phoneNumber: "555-0100",
                linkPrecedence: "primary",
            },
        });

        const countBefore = await prisma.contact.count();

        const { status, body } = await post(server, "/identify", {
            email: "mcfly@hillvalley.edu",
            phoneNumber: "555-0100",
        });

        expect(status).toBe(200);
        const countAfter = await prisma.contact.count();
        expect(countAfter).toBe(countBefore); // nothing new should have been inserted

        const { contact } = body;
        expect(contact.emails).toContain("mcfly@hillvalley.edu");
        expect(contact.phoneNumbers).toContain("555-0100");
        expect(contact.secondaryContactIds).toEqual([]);
    });

    test("exact match also works if the matching row is a secondary", async () => {
        // set up a primary + one secondary, then request the secondary's exact combo
        const primary = await prisma.contact.create({
            data: {
                email: "primary@test.com",
                phoneNumber: "1111",
                linkPrecedence: "primary",
            },
        });
        await prisma.contact.create({
            data: {
                email: "secondary@test.com",
                phoneNumber: "2222",
                linkedId: primary.id,
                linkPrecedence: "secondary",
            },
        });

        const countBefore = await prisma.contact.count();

        const { status, body } = await post(server, "/identify", {
            email: "secondary@test.com",
            phoneNumber: "2222",
        });

        expect(status).toBe(200);
        expect(await prisma.contact.count()).toBe(countBefore); // still no new row
        // response should still point to the root primary, not the secondary
        expect(body.contact.primaryContactId).toBe(primary.id);
    });

    test("does NOT create a secondary when both fields are covered across separate rows", async () => {
        // this is the tricky case the old exactExists check got wrong:
        // email exists on one row, phone exists on a different row â€”
        // the old check would have created a new secondary because no single
        // row held both fields together. the new isNewInformation check
        // correctly sees both fields as already covered and does nothing
        const primary = await prisma.contact.create({
            data: {
                email: "emma@test.com",
                phoneNumber: "111",
                linkPrecedence: "primary",
            },
        });
        // secondary holds the other phone number we'll be asking about
        await prisma.contact.create({
            data: {
                email: null,
                phoneNumber: "222",
                linkedId: primary.id,
                linkPrecedence: "secondary",
            },
        });

        const countBefore = await prisma.contact.count();

        // email is on the primary, phone 222 is on the secondary â€” both covered
        const { status, body } = await post(server, "/identify", {
            email: "emma@test.com",
            phoneNumber: "222",
        });

        expect(status).toBe(200);
        // no new row should have been created â€” both fields already existed
        expect(await prisma.contact.count()).toBe(countBefore);
        expect(body.contact.primaryContactId).toBe(primary.id);
    });
});

// --- case 3: partial match ---
// one field matches an existing contact, but the combination is new
// should create a secondary under the matched primary
describe("Case 3 â€“ Partial Match (new secondary)", () => {
    test("creates a secondary contact when only one field matches", async () => {
        const primary = await prisma.contact.create({
            data: {
                email: "doc@hillvalley.edu",
                phoneNumber: "555-FLUX",
                linkPrecedence: "primary",
            },
        });

        // same email, but a new phone number â€” partial match
        const { status, body } = await post(server, "/identify", {
            email: "doc@hillvalley.edu",
            phoneNumber: "555-NEW",
        });

        expect(status).toBe(200);

        const { contact } = body;
        expect(contact.primaryContactId).toBe(primary.id); // primary stays the same
        expect(contact.phoneNumbers).toContain("555-FLUX");
        expect(contact.phoneNumbers).toContain("555-NEW"); // both phones in response
        expect(contact.emails[0]).toBe("doc@hillvalley.edu"); // primary's email is first
        expect(contact.secondaryContactIds).toHaveLength(1); // one new secondary

        // verify the secondary was actually written correctly
        const rows = await prisma.contact.findMany({});
        expect(rows).toHaveLength(2);
        const secondary = rows.find((r) => r.linkPrecedence === "secondary");
        expect(secondary).toBeDefined();
        expect(secondary.linkedId).toBe(primary.id);
        expect(secondary.phoneNumber).toBe("555-NEW");
    });

    test("creates a secondary when only phoneNumber matches", async () => {
        const primary = await prisma.contact.create({
            data: {
                email: "biff@hillvalley.edu",
                phoneNumber: "555-BIFF",
                linkPrecedence: "primary",
            },
        });

        const { status, body } = await post(server, "/identify", {
            email: "biff2@hillvalley.edu",
            phoneNumber: "555-BIFF",
        });

        expect(status).toBe(200);
        expect(body.contact.primaryContactId).toBe(primary.id);
        expect(body.contact.secondaryContactIds).toHaveLength(1);
        expect(body.contact.emails).toContain("biff@hillvalley.edu");
        expect(body.contact.emails).toContain("biff2@hillvalley.edu");
    });
});

// --- case 4: two separate primaries need to be merged ---
// the incoming request has email from one primary and phone from another
// the older one becomes the true primary, the newer one gets demoted
// any secondaries that were under the demoted one get re-linked to the winner
describe("Case 4 â€“ Two Primaries Merge", () => {
    test("demotes newer primary and consolidates groups", async () => {
        // older one â€” this should survive as the primary
        const olderPrimary = await prisma.contact.create({
            data: {
                email: "george@hillvalley.edu",
                phoneNumber: "555-GEORGE",
                linkPrecedence: "primary",
                createdAt: new Date("2023-01-01T00:00:00Z"),
            },
        });

        const newerPrimary = await prisma.contact.create({
            data: {
                email: "lorraine@hillvalley.edu",
                phoneNumber: "555-LORRAINE",
                linkPrecedence: "primary",
                createdAt: new Date("2024-01-01T00:00:00Z"),
            },
        });

        // this secondary is under the newer primary â€” after the merge it should point to the older one
        const newerSecondary = await prisma.contact.create({
            data: {
                email: "lorraine2@hillvalley.edu",
                phoneNumber: "555-LORRAINE2",
                linkedId: newerPrimary.id,
                linkPrecedence: "secondary",
                createdAt: new Date("2024-06-01T00:00:00Z"),
            },
        });

        // this request bridges both groups â€” george's email + lorraine's phone
        const { status, body } = await post(server, "/identify", {
            email: "george@hillvalley.edu",
            phoneNumber: "555-LORRAINE",
        });

        expect(status).toBe(200);

        const { contact } = body;
        expect(contact.primaryContactId).toBe(olderPrimary.id); // older one wins

        // make sure the newer primary was actually demoted in the DB
        const demoted = await prisma.contact.findUnique({
            where: { id: newerPrimary.id },
        });
        expect(demoted.linkPrecedence).toBe("secondary");
        expect(demoted.linkedId).toBe(olderPrimary.id);

        // and its old secondary should now point to the winner too
        const relinked = await prisma.contact.findUnique({
            where: { id: newerSecondary.id },
        });
        expect(relinked.linkedId).toBe(olderPrimary.id);

        // all the emails and phones from both groups should show up
        expect(contact.emails).toContain("george@hillvalley.edu");
        expect(contact.emails).toContain("lorraine@hillvalley.edu");
        expect(contact.phoneNumbers).toContain("555-GEORGE");
        expect(contact.phoneNumbers).toContain("555-LORRAINE");
        // older primary's values always come first
        expect(contact.emails[0]).toBe("george@hillvalley.edu");
        expect(contact.phoneNumbers[0]).toBe("555-GEORGE");
    });

    test("does not create a duplicate secondary if the combination already exists post-merge", async () => {
        // two primaries â€” alpha has email+111, beta has email+222
        const older = await prisma.contact.create({
            data: {
                email: "alpha@test.com",
                phoneNumber: "111",
                linkPrecedence: "primary",
                createdAt: new Date("2023-01-01T00:00:00Z"),
            },
        });

        const newer = await prisma.contact.create({
            data: {
                email: "beta@test.com",
                phoneNumber: "222",
                linkPrecedence: "primary",
                createdAt: new Date("2024-01-01T00:00:00Z"),
            },
        });

        const countBefore = await prisma.contact.count();

        // alpha's email + beta's phone â†’ triggers a merge
        // but both fields are already accounted for in the merged group
        // so no extra secondary should be created
        const { status } = await post(server, "/identify", {
            email: "alpha@test.com",
            phoneNumber: "222",
        });

        expect(status).toBe(200);
        const countAfter = await prisma.contact.count();
        // demotion is just an update, not an insert â€” row count stays the same
        expect(countAfter).toBe(countBefore);
    });

    test("creates a new secondary after merge when a field is genuinely new to the merged group", async () => {
        // two primaries get merged, but the incoming request also has a brand-new
        // email that neither group had before â€” so a secondary should be created
        const olderPrimary = await prisma.contact.create({
            data: {
                email: "old@test.com",
                phoneNumber: "555-OLD",
                linkPrecedence: "primary",
                createdAt: new Date("2023-01-01T00:00:00Z"),
            },
        });

        const newerPrimary = await prisma.contact.create({
            data: {
                email: "new@test.com",
                phoneNumber: "555-NEW",
                linkPrecedence: "primary",
                createdAt: new Date("2024-01-01T00:00:00Z"),
            },
        });

        const countBefore = await prisma.contact.count();

        // old@test.com ties to the older group, 555-NEW ties to the newer group
        // so this triggers a merge â€” but the phone 555-BRAND-NEW is not in either group
        const { status, body } = await post(server, "/identify", {
            email: "old@test.com",
            phoneNumber: "555-BRAND-NEW",
        });

        expect(status).toBe(200);
        // a new secondary should have been created for the unseen phone number
        expect(await prisma.contact.count()).toBe(countBefore + 1);
        expect(body.contact.primaryContactId).toBe(olderPrimary.id);
        expect(body.contact.phoneNumbers).toContain("555-BRAND-NEW");
    });
});

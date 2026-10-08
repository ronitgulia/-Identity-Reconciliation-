Identity Reconciliation Service

A backend service that links different customer contact details (email/phone) back to the same person, even when they use different combinations across orders.

Built for the classic "Bitespeed" identity reconciliation problem — the idea is someone might place multiple orders using different emails/phone numbers, and this service figures out which contacts actually belong to the same person and consolidates them.

Tech Stack
Node.js + Express
Prisma ORM
SQLite
Jest (unit tests)
How It Works

Every contact is stored with a linkPrecedence of either primary or secondary. The first time someone shows up, they get a primary contact. Any new email/phone combo tied to that same person later gets added as a secondary, linked back to the primary via linkedId.

If a request comes in that connects two previously separate primaries (e.g. one email matches group A, and the phone number matches group B), the older primary stays primary and the newer one gets demoted to secondary — along with anything that was linked to it.

There's one endpoint: POST /identify

The 4 Cases It Handles
No match — nothing in the DB matches this email/phone → new primary created
Exact match — both fields already exist somewhere in the group → nothing new created, just returns current state
Partial match — one field matches, but this combo is new → creates a secondary
Two primaries merge — request links two separate primary groups → older wins, newer demoted, orphaned secondaries re-linked (all inside a transaction so it doesn't leave the DB half-updated if something fails)
Setup

Clone the repo and install dependencies:

bash
git clone https://github.com/ronitgulia/-Identity-Reconciliation-.git
cd ./-Identity-Reconciliation-
npm install

Create a .env file in the root:

env
DATABASE_URL="file:./dev.db"

Generate the Prisma client and create the SQLite database:

bash
npx prisma generate
npx prisma migrate dev --name init
Running the App
bash
node src/index.js
Running the Tests
bash
npm test
Project Structure
text
.
├── prisma/
│   └── schema.prisma               # Contact model definition
├── src/
│   ├── index.js                    # Express app entry point
│   ├── db.js                       # Singleton Prisma client
│   ├── routes/
│   │   └── identify.js             # POST /identify route
│   └── controllers/
│       └── identifyController.js   # All 4 business logic cases
├── tests/
│   └── identify.test.js            # Jest tests (one per case + validation)
├── .env                            # DATABASE_URL for Prisma
├── package.json
└── README.md

// just a single shared prisma instance — if I import this in multiple places
// node's module cache makes sure they all get the same object, so I'm not
// accidentally opening a new DB connection every time something requires it

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

module.exports = prisma;
// this is the entry point — sets up express, plugs in the router, and starts listening
// keeping it minimal on purpose, all the actual logic lives in the controller

const express = require("express");
const identifyRouter = require("./routes/identify");

const app = express();
const PORT = process.env.PORT || 3000;

// I'm wrapping the built-in express.json() middleware so I can catch malformed
// JSON myself and return a clean 400 instead of letting express blow up with
// its default ugly error object
app.use((req, res, next) => {
    express.json()(req, res, (err) => {
        if (err) {
            return res
                .status(400)
                .json({ error: "Malformed JSON in request body." });
        }
        next();
    });
});

app.use("/", identifyRouter);

// catch anything that doesn't match a real route
app.use((req, res) => {
    res.status(404).json({ error: "Route not found." });
});

// only start the server if this file is run directly (node src/index.js)
// when jest imports this file it shouldn't try to bind a port
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Identity Reconciliation service listening on port ${PORT}`);
    });
}

module.exports = app; // tests need this to spin up their own server instance
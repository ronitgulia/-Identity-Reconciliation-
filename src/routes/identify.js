// just wiring up the route here, nothing fancy
// the actual logic is all in identifyController so this file stays clean

const { Router } = require("express");
const { identify } = require("../controllers/identifyController");

const router = Router();

// POST /identify — takes { email, phoneNumber }, returns the consolidated contact
router.post("/identify", identify);

module.exports = router;
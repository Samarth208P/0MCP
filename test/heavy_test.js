import { execSync } from "child_process";

// ANSI color functions
const c = {
    reset:   (s) => `\x1b[0m${s}\x1b[0m`,
    bold:    (s) => `\x1b[1m${s}\x1b[0m`,
    green:   (s) => `\x1b[32m${s}\x1b[0m`,
    red:     (s) => `\x1b[31m${s}\x1b[0m`,
    cyan:    (s) => `\x1b[36m${s}\x1b[0m`,
    yellow:  (s) => `\x1b[33m${s}\x1b[0m`,
    dim:     (s) => `\x1b[2m${s}\x1b[0m`,
    magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};

const TEST_PROJECT = "heavy-test-" + Date.now();
const TEST_LABEL = "agent-" + Math.floor(Math.random() * 10000);
const FULL_NAME = `${TEST_LABEL}.0mcp.eth`;
const RENTER_ADDR = "0x1234567890123456789012345678901234567890";

function log(msg) {
    console.error(`${c.cyan("►")} ${msg}`);
}

function success(msg) {
    console.error(`${c.green("✓")} ${msg}`);
}

function failure(msg, error) {
    console.error(`${c.red("✗")} ${msg}`);
    if (error) console.error(error.toString());
    process.exit(1);
}

function run(cmd, silent = false) {
    if (!silent) console.error(`${c.dim("  $ 0mcp " + cmd)}`);
    try {
        // MERGE stderr into stdout because 0mcp CLI uses stderr for all human logs
        const out = execSync(`node build/src/cli.js ${cmd} 2>&1`, { 
            encoding: "utf8"
        });
        return out;
    } catch (e) {
        if (e.stdout) console.error(e.stdout);
        throw e;
    }
}

async function heavyTest() {
    console.error(`\n${c.bold(c.magenta("╔════════════════════════════════════════════════════════════╗"))}`);
    console.error(`${c.bold(c.magenta("║             0MCP HEAVY INTEGRATION TEST SUITE              ║"))}`);
    console.error(`${c.bold(c.magenta("╚════════════════════════════════════════════════════════════╝"))}\n`);

    log(`Initializing Heavy Test...`);
    log(`Project ID: ${c.bold(TEST_PROJECT)}`);
    log(`Agent Label: ${c.bold(TEST_LABEL)}`);
    log(`Target ENS: ${c.bold(FULL_NAME)}`);

    // 1. Health Check
    try {
        log("Testing [health]...");
        const health = run("health");
        if (health.includes("✗")) {
            console.error(health);
            throw new Error("Health check reported failure");
        }
        success("Health OK");
    } catch (e) { failure("Health check failed", e); }

    // 2. Wallet Status
    try {
        log("Testing [wallet status]...");
        run("wallet status");
        success("Wallet status OK");
    } catch (e) { failure("Wallet status failed", e); }

    // 3. Keygen
    try {
        log("Testing [keygen]...");
        const keys = run("keygen");
        if (!keys.includes("Private Key:")) {
            console.error(keys);
            throw new Error("Keygen output malformed");
        }
        success("Keygen OK");
    } catch (e) { failure("Keygen failed", e); }

    // 4. ENS Registration
    try {
        log(`Testing [ens register] for ${FULL_NAME}...`);
        run(`ens register ${TEST_PROJECT} ${TEST_LABEL} --desc "Heavy Test Agent"`);
        success("Registration successful");
    } catch (e) { failure("Registration failed", e); }

    // 5. ENS Resolve
    try {
        log(`Testing [ens resolve] for ${FULL_NAME}...`);
        const resolve = run(`ens resolve ${FULL_NAME} --json`);
        const meta = JSON.parse(resolve);
        if (meta.name !== FULL_NAME) throw new Error("Names mismatch");
        success("Resolution verified");
    } catch (e) { failure("Resolution failed", e); }

    // 6. ENS Rename
    const NEW_LABEL = TEST_LABEL + "-v2";
    const NEW_NAME = `${NEW_LABEL}.0mcp.eth`;
    try {
        log(`Testing [ens rename] ${FULL_NAME} -> ${NEW_NAME}...`);
        run(`ens rename ${FULL_NAME} ${NEW_LABEL}`);
        success("Rename successful");
        
        log(`Verifying new name resolution...`);
        const resolveNew = run(`ens resolve ${NEW_NAME} --json`);
        const meta2 = JSON.parse(resolveNew);
        if (meta2.name !== NEW_NAME) throw new Error("Internal rename verify failed");
        success("Rename verified");
    } catch (e) { failure("Rename failed", e); }

    // 7. ENS Issue Rental
    try {
        log(`Testing [ens issue] rental for ${RENTER_ADDR}...`);
        const issue = run(`ens issue ${NEW_NAME} ${RENTER_ADDR}`);
        const match = issue.match(/renter-[a-z0-9]+\.[^ ]+/);
        if (!match) throw new Error("Could not find rental subname in output");
        const subname = match[0];
        success(`Rental issued: ${subname}`);

        log(`Testing [ens verify] for ${subname}...`);
        const verify = run(`ens verify ${subname} --json`);
        const vres = JSON.parse(verify);
        if (!vres.valid) throw new Error("Rental verification failed (invalid)");
        success("Rental verified");
    } catch (e) { failure("Rental flow failed", e); }

    // 8. Brain Status & Share
    try {
        log("Testing [brain share]...");
        run(`brain share ${TEST_PROJECT}`);
        success("Brain share OK");

        log("Testing [brain status]...");
        run(`brain status ${TEST_PROJECT}`);
        success("Brain status OK");
    } catch (e) { failure("Brain tools failed", e); }

    // 9. Memory List
    try {
        log("Testing [memory list]...");
        run(`memory list ${TEST_PROJECT}`);
        success("Memory list OK");
    } catch (e) { failure("Memory list failed", e); }

    // 10. Wallet Projects
    try {
        log("Testing [wallet projects]...");
        const projects = run("wallet projects --json");
        const plist = JSON.parse(projects);
        if (!plist.projects.includes(TEST_PROJECT)) throw new Error("Recently registered project not in list");
        success("Project list OK");
    } catch (e) { failure("Project list failed", e); }
    
    // 11. INFT Status (Static check)
    try {
        log("Testing [inft status] (static check on contract)...");
        run(`inft status 0xd07059e54017BbF424223cb089ffBC5e2558cF56 1`);
        success("INFT status OK");
    } catch (e) { failure("INFT status failed", e); }

    console.error(`\n${c.bold(c.green("╔════════════════════════════════════════════════════════════╗"))}`);
    console.error(`${c.bold(c.green("║          ALL COMMANDS TESTED SUCCESSFULLY — 100% READY     ║"))}`);
    console.error(`${c.bold(c.green("╚════════════════════════════════════════════════════════════╝"))}\n`);
}

heavyTest().catch(e => {
    console.error(e);
    process.exit(1);
});

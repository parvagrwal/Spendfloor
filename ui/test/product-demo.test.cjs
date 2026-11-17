/*
 * Browser-model smoke and workflow suite for the dependency-free product demo.
 * Run: npm run test:demo
 *
 * jsdom is deliberately used here because the product demo has no runtime
 * framework, server API, wallet, or RPC requirement. The test drives the
 * actual DOM and inline application script, captures runtime errors, and
 * verifies all stateful interactions deterministically.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const FILE = path.resolve(__dirname, "..", "index.html");
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadDemo() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  virtualConsole.on("error", (error) => errors.push(error));

  const dom = await JSDOM.fromFile(FILE, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    url: "http://demo.local/",
    virtualConsole,
  });
  const { window } = dom;
  const originalTimer = window.setTimeout.bind(window);
  // All state transitions are intentionally timer-driven. Speed them up
  // without changing their order so this remains a fast deterministic suite.
  window.setTimeout = (fn, delay, ...args) => originalTimer(fn, Math.min(Number(delay) || 0, 8), ...args);
  let lastScrolledId = null;
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    lastScrolledId = this.id || null;
  };

  const click = (selector) => {
    const element = window.document.querySelector(selector);
    assert(element, `Expected visible control: ${selector}`);
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    return element;
  };
  const key = (value, options = {}) => window.document.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }),
  );
  const input = (selector, value, eventType = "input") => {
    const element = window.document.querySelector(selector);
    assert(element, `Expected input: ${selector}`);
    element.value = value;
    element.dispatchEvent(new window.Event(eventType, { bubbles: true }));
    return element;
  };
  const submit = () => {
    window.document.getElementById("scenario-form").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  };
  const run = async () => {
    submit();
    await wait();
  };
  const runByButton = async () => {
    window.document.getElementById("run-button").click();
    await wait();
  };

  return {
    dom,
    window,
    document: window.document,
    errors,
    click,
    key,
    input,
    run,
    runByButton,
    get lastScrolledId() { return lastScrolledId; },
  };
}

function status(app) {
  return app.document.getElementById("run-status").textContent;
}
function summary(app) {
  return app.document.getElementById("run-summary").textContent;
}

async function testEntryStateAndStaticControls(app) {
  const { document } = app;
  assert.equal(document.title, "SpendFloor — Policy, not prompts");
  assert.equal(document.documentElement.classList.contains("js"), true, "progressive enhancement starts");
  assert.equal(document.getElementById("advanced-controls").open, false, "advanced configuration stays out of the presentation path");
  assert.equal(status(app), "AWAITING INTENT");
  assert.match(summary(app), /Ready for a controlled test/);
  assert.equal(document.querySelectorAll("#trace-body .trace-row").length, 8, "empty trace still explains every decision point");
  assert.equal(document.querySelectorAll(".scenario").length, 4, "all prepared scenarios are present");
  assert.equal(document.querySelectorAll(".arch-node").length, 4, "all architecture controls are present");
  assert.equal(document.querySelectorAll(".draft-tab").length, 3, "all policy-diff controls are present");
  assert.equal(document.querySelectorAll(".proof-table tbody tr").length, 5, "all recorded evidence rows are present");
  assert.equal(document.querySelectorAll(".reveal-section").length, 0, "sections are not hidden behind scroll-only reveals");
  assert.match(document.getElementById("proof").textContent, /Recorded rejections/, "evidence is rendered immediately");

  const nav = [...document.querySelectorAll("nav a")];
  assert.deepEqual(nav.map((link) => link.getAttribute("href")), ["#lab", "#system", "#proof", "#limits"]);
  for (const link of [...document.querySelectorAll(".proof-table a"), ...document.querySelectorAll(".footer-links a")]) {
    assert.match(link.href, /^https?:\/\//, "reference links have valid external URLs");
    assert.equal(link.target, "_blank", "external references do not interrupt the demo page");
  }
}

async function testCommandDeck(app) {
  const { document, click, key } = app;
  click("#command-launcher");
  assert.equal(document.getElementById("command-layer").classList.contains("is-open"), true);
  assert.equal(document.getElementById("command-launcher").getAttribute("aria-expanded"), "true");
  const controls = [...document.querySelectorAll("#command-layer button")];
  controls[0].focus();
  key("Tab", { shiftKey: true });
  assert.equal(document.activeElement, controls.at(-1), "command dialog wraps focus backward");
  key("Escape");
  assert.equal(document.getElementById("command-layer").classList.contains("is-open"), false, "Escape closes dialog");

  key("k", { ctrlKey: true });
  assert.equal(document.getElementById("command-layer").classList.contains("is-open"), true, "Ctrl+K opens dialog");
  key("2");
  assert.equal(status(app), "EVALUATING", "keyboard command starts payout");
  assert.equal(document.getElementById("run-panel").getAttribute("aria-busy"), "true");
  await wait();
  assert.equal(status(app), "ACCEPTED");
  assert.match(document.querySelector("#trace-body .is-success").textContent, /Per-transfer cap/);

  click("#command-launcher");
  click('[data-command="clear"]');
  assert.match(summary(app), /Trace cleared/);
  assert.match(document.getElementById("activity-list").textContent, /No local decisions/);

  click("#command-launcher");
  click('[data-command="evidence"]');
  assert.equal(app.lastScrolledId, "proof", "evidence command navigates to on-page proof");

  click("#command-launcher");
  click('[data-command="reset"]');
  assert.equal(status(app), "AWAITING INTENT");
  assert.equal(document.getElementById("amount").value, "50");
}

async function testPreparedScenariosAndTransitions(app) {
  const cases = [
    ["attack", "REJECTED", "RecipientNotAllowed"],
    ["legit", "ACCEPTED", "ACCEPT on both represented paths"],
    ["frozen", "REJECTED", "Frozen"],
    ["window", "REJECTED", "DailyCapExceeded"],
  ];
  for (const [index, [scenario, expectedStatus, expectedText]] of cases.entries()) {
    app.click(`[data-scenario="${scenario}"]`);
    // Alternate form submit and visible primary-button activation, covering both paths.
    if (index % 2) await app.runByButton(); else await app.run();
    assert.equal(status(app), expectedStatus, `${scenario} transitions to its expected decision`);
    assert.match(summary(app), new RegExp(expectedText));
  }
  assert.match(app.document.querySelector("#trace-body .is-failure").textContent, /Window budget/, "first failed rule is visually identifiable");

  app.click('[data-scenario="legit"]');
  await app.run();
  assert.match(app.document.getElementById("policy-spent").textContent, /2 \/ 5/, "accepted run advances local meter");
  app.click("#reset-lab");
  assert.match(app.document.getElementById("policy-spent").textContent, /1 \/ 5/, "reset restores deterministic state");
  app.click('[data-scenario="legit"]');
  await app.run();
  assert.match(app.document.getElementById("policy-spent").textContent, /2 \/ 5/, "reset makes accepted workflow repeatable");
}

async function testCustomInputsAndErrors(app) {
  const { document, click, input } = app;
  const advancedSummary = document.querySelector("#advanced-controls summary");
  advancedSummary.dispatchEvent(new app.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(document.getElementById("advanced-controls").open, true, "advanced controls can be opened without setup dependency");

  input("#message", "Custom policy context");
  assert.equal(document.querySelectorAll(".scenario.active").length, 0, "manual edit marks intent as custom");

  click('[data-scenario="legit"]');
  input("#amount", "0");
  await app.run();
  assert.match(summary(app), /ZeroAmount/);

  click('[data-scenario="legit"]');
  input("#signer", "attacker", "change");
  await app.run();
  assert.match(summary(app), /Unauthorized/);

  click('[data-scenario="legit"]');
  input("#policy-state", "expired", "change");
  await app.run();
  assert.match(summary(app), /SessionExpired/);

  click('[data-scenario="legit"]');
  input("#transport", "replay", "change");
  await app.run();
  assert.match(document.getElementById("trace-body").textContent, /BadNonce/, "EVM transport edge is represented");
  assert.match(document.getElementById("trace-body").textContent, /N\/A/, "Solana transport distinction is explicit");

  click('[data-scenario="legit"]');
  input("#amount", "1.0000001");
  await app.run();
  assert.equal(status(app), "INPUT ERROR");
  assert.equal(document.getElementById("advanced-controls").open, true);
  assert.equal(document.getElementById("amount").getAttribute("aria-invalid"), "true");
  assert.match(document.getElementById("input-error").textContent, /six decimal places/);

  click("#try-legit");
  await wait();
  assert.equal(status(app), "ACCEPTED", "recovery action exits validation error without setup");
  click("#clear-trace");
  assert.match(summary(app), /Trace cleared/);
}

async function testArchitectureDraftEvidenceAndScheduledReset(app) {
  const { document, click } = app;
  const architecture = [
    ["owner", /owner defines the boundary/i],
    ["agent", /sign, not custody/i],
    ["relay", /forwards; it does not decide/i],
    ["vault", /irreversible decision/i],
  ];
  for (const [node, expected] of architecture) {
    click(`[data-node="${node}"]`);
    assert.match(document.getElementById("architecture-detail").textContent, expected);
  }

  const drafts = [
    ["equal", /eligible for owner review/i],
    ["looser", /LOOSER.*blocked/i],
    ["tighter", /distinct owner choice/i],
  ];
  for (const [draft, expected] of drafts) {
    click(`[data-draft="${draft}"]`);
    assert.match(document.getElementById("draft-result").textContent, expected);
  }

  click("#hero-run");
  assert.equal(status(app), "AWAITING INTENT", "hero trigger schedules rather than immediately fakes a result");
  click("#global-reset");
  await wait();
  assert.equal(status(app), "AWAITING INTENT", "global reset cancels scheduled hero evaluation");
  assert.equal(document.getElementById("amount").value, "50");
}

function testResponsiveAndMotionContracts() {
  const html = require("node:fs").readFileSync(FILE, "utf8");
  // Responsive layout is CSS-first: desktop grid rules collapse at two explicit
  // breakpoints and controls remain in the DOM at all widths.
  assert.match(html, /@media \(max-width: 900px\)/);
  assert.match(html, /\.hero, \.lab, \.split-grid, \.arch-layout \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /@media \(max-width: 630px\)/);
  assert.match(html, /\.field-grid, \.policy-facts \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /\.pipeline \{ grid-template-columns: 1fr; gap: \.35rem; \}/);
  assert.match(html, /\.proof-table th:nth-child\(3\), \.proof-table td:nth-child\(3\) \{ display: none; \}/);
  // Motion is intentionally limited: execution feedback is the only continuous
  // motion; the policy seal is hover-triggered once; reduced-motion disables all.
  assert.match(html, /policy-artifact:hover \.orbit-a \{ animation: signalSpin 4\.8s linear 1; \}/);
  assert.match(html, /body\.evaluating \.pipe-arrow \{[^}]*animation: routePulse 1s ease-in-out infinite alternate;/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{[^}]*animation-duration: \.01ms !important;/);
}

(async () => {
  const app = await loadDemo();
  try {
    await testEntryStateAndStaticControls(app);
    await testCommandDeck(app);
    await testPreparedScenariosAndTransitions(app);
    await testCustomInputsAndErrors(app);
    await testArchitectureDraftEvidenceAndScheduledReset(app);
    testResponsiveAndMotionContracts();
    assert.equal(app.errors.length, 0, `Unexpected browser-model runtime errors:\n${app.errors.map(String).join("\n")}`);
    console.log("Product demo interaction suite: PASS");
  } finally {
    app.dom.window.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { json, mutation, mutationMethod } from "./api.js";
import { configurePreferences, formatDate, t } from "./i18n.js";
import { diagnosticFor, esc, nextAction } from "./presentation.js";
import { state } from "./state.js";

const $ = (selector) => document.querySelector(selector);
const content = $("#content");
const errorBox = $("#error");

async function loadGlobal() {
  const [preflight, projects, memory, preferenceData] = await Promise.all([
    json("/api/preflight"),
    json("/api/projects"),
    json("/api/memory").catch(() => null),
    json("/api/preferences").catch(() => ({ preferences: state.preferences })),
  ]);
  state.preflight = preflight;
  state.projects = projects.projects;
  state.memory = memory;
  state.preferences = preferenceData.preferences;
  configurePreferences(state.preferences);
  renderChrome();
  renderProjects();
  renderHealth();
}

function renderProjects() {
  $("#projects").innerHTML = state.projects.map((entry) => `
    <button class="project ${state.project?.id === entry.project.id ? "active" : ""}" data-project="${esc(entry.project.id)}">
      <strong><span class="state-dot ${esc(entry.state)}"></span>${esc(entry.project.name)}</strong>
      <small>${esc(entry.state)} · ${esc(entry.project.path)}</small>
      ${entry.attention?.count ? `<span class="attention-badge ${esc(entry.attention.highestSeverity)}">${entry.attention.count} · ${t("attention")}</span>` : ""}
    </button>`).join("") || '<p class="muted">No recent projects.</p>';
}

function renderChrome() {
  $("#projects-label").textContent = t("projects");
  $("#runtime-label").textContent = t("runtime");
  $("#add-project").textContent = t("addProject");
  $("#language-label").textContent = t("language");
  $("#theme-label").textContent = t("theme");
  $("#locale-select").value = state.preferences.locale;
  $("#theme-select").value = state.preferences.theme;
  const localeLabels = { auto: "automatic", es: "spanish", en: "english" };
  const themeLabels = { system: "system", light: "light", dark: "dark" };
  [...$("#locale-select").options].forEach((option) => { option.textContent = t(localeLabels[option.value]); });
  [...$("#theme-select").options].forEach((option) => { option.textContent = t(themeLabels[option.value]); });
  const labels = { overview: "overview", planning: "plan", tickets: "tickets", activity: "activity", dag: "dag", history: "history", sessions: "sessions", settings: "settings" };
  document.querySelectorAll("[data-tab]").forEach((button) => { button.textContent = t(labels[button.dataset.tab]); });
  $("#advanced-label").textContent = t("advanced");
}

function renderHealth() {
  if (!state.preflight) return;
  const diagnostics = [
    ...state.preflight.essential.map((item) => ({ label: item.name, ok: item.ok, message: item.message })),
    ...state.preflight.tools.map((item) => ({ label: item.name, ok: item.ok, message: item.message })),
    ...state.preflight.providers.map((provider) => ({
      label: provider.provider,
      ok: provider.executable,
      message: provider.diagnostics.map((item) => item.message).join(" · ") || (provider.executable ? "Available" : "Unavailable"),
    })),
    ...(state.memory ? [{
      label: "engram",
      ok: state.memory.available,
      message: state.memory.diagnostics.map((item) => item.message).join(" · "),
    }] : []),
  ];
  $("#health").innerHTML = diagnostics.map((item) => `<span class="pill ${item.ok ? "ok" : "bad"}" title="${esc(item.message)}">${esc(item.label)}</span>`).join(" ");
  $("#sidebar-health").textContent = state.preflight.canExecute ? "Ready to execute" : state.preflight.canServe ? "UI ready · agents disabled" : "Node upgrade required";
}

function showLanding() {
  state.project = null;
  state.projectEntry = null;
  state.inspection = null;
  $("#nav").classList.add("hidden");
  $("#view-kicker").textContent = t("localWorkspace");
  $("#project-name").textContent = t("chooseWork");
  $("#project-path").textContent = "";
  renderProjects();
  const providerNote = state.preflight?.canExecute
    ? "An agent provider is ready."
    : "The interface is available, but agent execution stays disabled until a provider is ready.";
  content.className = "hero";
  content.innerHTML = `
    <p class="kicker">One host · many projects</p>
    <h2>Open a repository, or start with an empty folder.</h2>
    <p>raycoder keeps every project runtime isolated and opens one only when you choose it. ${esc(providerNote)}</p>
    <div class="hero-actions"><button class="primary" data-onboard="existing">Open existing folder</button><button data-onboard="create">Create new project</button><button id="refresh-preflight">Refresh diagnostics</button></div>
    <section><p class="kicker">Recent projects</p><div class="grid">${state.projects.map((entry) => `
      <article class="card"><div class="row"><h3>${esc(entry.project.name)}</h3><span class="status">${esc(entry.state)}</span></div><p>${esc(entry.project.path)}</p>${entry.error ? `<p class="error">${esc(entry.error)}</p>` : ""}<button data-project="${esc(entry.project.id)}">Open</button></article>`).join("") || '<div class="empty">Your recent projects will appear here.</div>'}</div></section>
    <section><p class="kicker">Preflight</p><div class="grid">${preflightCards()}</div></section>`;
}

function preflightCards() {
  if (!state.preflight) return "";
  const cards = [
    ...state.preflight.essential,
    ...state.preflight.tools,
    ...state.preflight.providers.map((provider) => ({
      name: provider.provider,
      ok: provider.executable,
      message: provider.diagnostics.map((item) => item.message).join(" · ") || "No diagnostic",
    })),
    ...(state.memory ? [{ name: "engram", ok: state.memory.available, message: state.memory.diagnostics.map((item) => item.message).join(" · ") }] : []),
  ];
  return cards.map((item) => `<article class="card"><div class="row"><h3>${esc(item.name)}</h3><span class="pill ${item.ok ? "ok" : "bad"}">${item.ok ? "ready" : "attention"}</span></div><p>${esc(item.message)}</p></article>`).join("");
}

async function selectProject(id) {
  let entry = state.projects.find((candidate) => candidate.project.id === id);
  if (!entry) return;
  if (!entry.open) {
    await json(`/api/projects/${encodeURIComponent(id)}/open`, mutation({}));
    await loadGlobal();
    entry = state.projects.find((candidate) => candidate.project.id === id);
  }
  if (!entry?.open) throw new Error(entry?.error || "Project could not be opened");
  state.project = entry.project;
  state.projectEntry = entry;
  state.inspection = await json(`${base()}/inspection`);
  $("#nav").classList.remove("hidden");
  $("#view-kicker").textContent = "Project";
  $("#project-name").textContent = entry.project.name;
  $("#project-path").textContent = entry.project.path;
  renderProjects();
  await refreshProject();
}

function base() {
  return `/api/projects/${encodeURIComponent(state.project.id)}`;
}

async function refreshProject() {
  if (!state.project) return;
  const [ticketData, dependencyData, planning, capabilities, inspection, preparation, verification, activity] = await Promise.all([
    json(`${base()}/tickets`), json(`${base()}/dependencies`), json(`${base()}/planning`), json(`${base()}/capabilities`), json(`${base()}/inspection`), json(`${base()}/preparation`), json(`${base()}/verification`), json(`${base()}/activity`),
  ]);
  state.tickets = ticketData.tickets;
  state.dependencies = dependencyData.dependencies;
  state.planning = planning;
  state.capabilities = capabilities;
  state.inspection = inspection;
  state.preparation = preparation;
  state.verification = verification;
  state.activity = activity;
  const entry = state.projects.find((candidate) => candidate.project.id === state.project.id);
  if (entry) entry.attention = activity.summary;
  renderProjects();
  const editing = content.contains(document.activeElement)
    && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (!editing) render();
  else renderProgress();
}

function render() {
  const renderer = {
    overview: renderOverview, planning: renderPlanning, tickets: renderTickets, dag: renderDag,
    activity: renderActivity, history: renderHistory, sessions: renderSessions, settings: renderSettings,
  }[state.tab];
  renderer();
  renderProgress();
}

function eligibility() {
  if (!state.inspection?.hasBaseCommit) return { allowed: false, reason: "Create the first Git commit to establish a baseline before running tickets." };
  if (!state.preflight?.canExecute) return { allowed: false, reason: "No executable agent provider is available." };
  return { allowed: true, reason: "" };
}

function ticketCard(ticket) {
  const attempt = ticket.integrationAttempt;
  const allowed = eligibility().allowed;
  const buttons = [];
  if (ticket.status === "READY") buttons.push(`<button data-ticket-action="run" data-ticket="${esc(ticket.id)}" class="primary" ${allowed ? "" : "disabled"}>Run</button>`);
  if (["FAILED", "BLOCKED", "INTERRUPTED", "CHANGES_REQUESTED"].includes(ticket.status)) buttons.push(`<button data-ticket-action="retry" data-ticket="${esc(ticket.id)}" ${allowed ? "" : "disabled"}>Retry</button>`);
  if (attempt?.status === "AWAITING_CONFIRMATION") buttons.push(`<button data-ticket-action="confirm" data-attempt="${esc(attempt.id)}" data-ticket="${esc(ticket.id)}" class="primary">Confirm</button>`);
  if (!["DONE", "CANCELLED"].includes(ticket.status)) buttons.push(`<button data-ticket-action="cancel" data-ticket="${esc(ticket.id)}">Cancel</button>`);
  const preparation = ticket.preparation;
  const verification = ticket.verification;
  return `<article class="card"><div class="row"><h3>${esc(ticket.title)}</h3><span class="status ${esc(ticket.status)}">${esc(ticket.status)}</span></div><p>${esc(ticket.description)}</p><small class="muted">${esc(ticket.id)}${ticket.branch ? ` · ${esc(ticket.branch)}` : ""}</small>${preparation ? `<p><small>Preparation: <span class="status ${esc(preparation.status)}">${esc(preparation.status)}</span> · ${esc(preparation.strategy)}</small></p>` : ""}${preparation?.diagnosticDetail ? `<p class="error">${esc(preparation.diagnosticCode)} · ${esc(preparation.diagnosticDetail)}</p>` : ""}${preparation?.output ? `<details><summary>Preparation output</summary><pre>${esc(preparation.output.slice(0, 2_000))}</pre></details>` : ""}${verification ? `<p><small>Verification: <span class="status ${esc(verification.status)}">${esc(verification.status)}</span> · ${esc(verification.strategy)}</small></p>` : ""}${verification?.diagnosticDetail ? `<p class="error">${esc(verification.diagnosticCode)} · ${esc(verification.diagnosticDetail)}</p>` : ""}${verification?.output ? `<details><summary>Verification output</summary><pre>${esc(verification.output.slice(0, 2_000))}</pre></details>` : ""}${ticket.review ? `<p><small>Review: ${esc(ticket.review.verdict)} — ${esc(ticket.review.summary)}</small></p>` : ""}${attempt?.diagnosticCode ? `<p class="error">${esc(attempt.diagnosticCode)} · ${esc(attempt.diagnosticDetail)}</p>` : ""}<div class="actions">${buttons.join("")}</div></article>`;
}

function renderOverview() {
  const counts = Object.fromEntries(state.tickets.map((ticket) => ticket.status).map((status) => [status, state.tickets.filter((ticket) => ticket.status === status).length]));
  const ready = eligibility();
  const next = nextAction(state);
  content.className = "stack";
  content.innerHTML = `
    <article class="next-action card"><div><p class="kicker">${t("nextAction")}</p><h2>${esc(next.label)}</h2></div><button class="primary" data-go-tab="${esc(next.tab)}">${t("go")}</button></article>
    <div class="grid">
      <article class="card"><h3>Repository</h3><p>${esc(state.inspection.branch || "unborn branch")} · ${state.inspection.head ? esc(state.inspection.head.slice(0, 10)) : "no baseline"} · ${state.inspection.dirty ? "dirty" : "clean"}</p></article>
      <article class="card"><h3>Tickets</h3><p>${state.tickets.length} total · ${counts.DONE || 0} done · ${counts.READY || 0} ready</p></article>
      <article class="card"><h3>Execution</h3><p>${ready.allowed ? "Eligible for agent runs" : esc(ready.reason)}</p></article>
    </div>
    <div class="split"><section><h2>Frontier</h2><div class="grid">${state.tickets.filter((ticket) => ["READY", "RUNNING", "REVIEW", "CHANGES_REQUESTED", "READY_TO_MERGE", "BLOCKED"].includes(ticket.status)).map(ticketCard).join("") || '<div class="empty">No active tickets.</div>'}</div></section>
    <section class="card"><div class="row"><h3>Preview</h3><div class="actions"><button data-preview="start">Start</button><button data-preview="stop">Stop</button></div></div><div id="preview">Loading…</div></section></div>`;
  void refreshPreview();
}

function renderPlanning() {
  const planning = state.planning || { artifacts: [], messages: [], sessions: [], events: [], providerAvailable: false };
  const artifacts = planning.artifacts;
  const approvedInterrogations = artifacts.filter((artifact) => artifact.kind === "interrogation" && artifact.status === "approved");
  const approvedSpecs = artifacts.filter((artifact) => artifact.kind === "spec" && artifact.status === "approved");
  const latestSpec = artifacts.filter((artifact) => artifact.kind === "spec").at(-1);
  const latestTickets = artifacts.filter((artifact) => artifact.kind === "tickets").at(-1);
  const active = planning.sessions.find((session) => ["idle", "running"].includes(session.status));
  const interrupted = planning.sessions.filter((session) => session.status === "interrupted");
  const failed = planning.sessions.filter((session) => session.status === "error" && !planning.sessions.some((candidate) => candidate.retryOfSessionId === session.id));
  const providerDisabled = planning.providerAvailable ? "" : "disabled";
  content.className = "stack";
  content.innerHTML = `
    <div class="planning-banner ${planning.providerAvailable ? "ready" : "offline"}">
      <strong>${planning.providerAvailable ? `${esc(state.capabilities?.provider || "Agent")} ready` : "Provider unavailable"}</strong>
      <span>Planning data and manual editing stay available${state.inspection?.hasBaseCommit ? "." : "; ticket execution waits for the first Git commit."}</span>
    </div>
    <div class="planning-layout">
      <section class="card conversation-panel">
        <div class="row"><div><p class="kicker">Conversation</p><h2>Shape the work together</h2></div><span class="status ${esc(planning.thread?.status || "idle")}">${esc(planning.thread?.status || "not started")}</span></div>
        <div class="transcript">${planning.messages.filter((message) => message.role !== "system").map((message) => `
          <div class="message ${esc(message.role)}"><small>${esc(message.role)} · ${formatDate(message.createdAt)}</small><p>${esc(message.content)}</p></div>`).join("") || '<div class="empty compact">Start with the outcome you want. The conversation is stored locally.</div>'}</div>
        <div class="composer"><textarea id="planning-message" placeholder="Describe the goal, answer a question, or correct an assumption…" ${providerDisabled}></textarea><button id="send-planning-message" class="primary" ${providerDisabled}>Send</button></div>
      </section>
      <aside class="card operation-panel">
        <p class="kicker">Durable operation</p>
        ${active ? planningOperation(active, planning.events) : '<p class="muted">No generation is running.</p>'}
        ${failed.map(planningErrorCard).join("")}
        ${interrupted.map((session) => `<div class="interrupted"><strong>${esc(session.stage)} interrupted</strong><small>${esc(session.errorDetail || "The previous runtime stopped.")}</small><button data-planning-resume="${esc(session.id)}" ${providerDisabled}>Resume</button></div>`).join("")}
        ${!planning.providerAvailable ? '<p class="warning">Generation and resume need an executable provider. Approval, editing and DAG confirmation do not.</p>' : ""}
      </aside>
    </div>
    <div class="planning-actions">
      <button id="generate-spec" class="primary" ${providerDisabled || active ? "disabled" : ""}>Generate SPEC from conversation</button>
      <button id="generate-tickets" ${providerDisabled || active || approvedSpecs.length === 0 ? "disabled" : ""}>Generate tickets from approved SPEC</button>
    </div>
    <section><div class="row"><div><p class="kicker">Revisions</p><h2>Review before execution</h2></div><small class="muted">Approve a revision, then confirm its DAG separately.</small></div>
      <div class="artifact-list">${artifacts.map(planningArtifact).join("") || '<div class="empty">No planning artifacts yet.</div>'}</div>
    </section>
    <div class="planning-layout editors">
      <section class="card"><p class="kicker">Structured SPEC editor</p><h3>${latestSpec ? `Edit SPEC v${latestSpec.revision}` : "New SPEC revision"}</h3>
        <label>Approved conversation snapshot<select id="spec-predecessor">${approvedInterrogations.map((artifact) => `<option value="${esc(artifact.id)}" ${artifact.id === latestSpec?.predecessorArtifactId ? "selected" : ""}>conversation v${artifact.revision}</option>`).join("")}</select></label>
        <label>Title<input id="spec-title" value="${esc(latestSpec?.content?.title || "")}" placeholder="Specification title"></label>
        <label>Summary<textarea id="spec-summary" placeholder="Short overview">${esc(latestSpec?.content?.summary || "")}</textarea></label>
        ${specListField("Goals", "spec-goals", latestSpec?.content?.goals)}
        ${specListField("Non-goals", "spec-non-goals", latestSpec?.content?.nonGoals)}
        ${specListField("Requirements", "spec-requirements", latestSpec?.content?.requirements)}
        ${specListField("Acceptance criteria", "spec-acceptance", latestSpec?.content?.acceptanceCriteria)}
        ${specListField("Constraints", "spec-constraints", latestSpec?.content?.constraints)}
        <button id="save-spec" class="primary" ${approvedInterrogations.length === 0 ? "disabled" : ""}>Save as new revision</button>
      </section>
      <section class="card"><p class="kicker">Ticket DAG editor</p><div class="row"><h3>${latestTickets ? `Edit ticket plan v${latestTickets.revision}` : "New ticket plan"}</h3><button id="add-plan-ticket">Add row</button></div>
        <label>Approved SPEC<select id="ticket-spec">${approvedSpecs.map((artifact) => `<option value="${esc(artifact.id)}" ${artifact.id === latestTickets?.predecessorArtifactId ? "selected" : ""}>SPEC v${artifact.revision} · ${esc(artifact.content?.title)}</option>`).join("")}</select></label>
        <div id="ticket-plan-rows" class="ticket-plan-rows">${(latestTickets?.content?.tickets || [{ id: "", title: "", description: "", predecessorIds: [] }]).map(ticketPlanRow).join("")}</div>
        <button id="save-ticket-plan" class="primary" ${approvedSpecs.length === 0 ? "disabled" : ""}>Validate and save revision</button>
      </section>
    </div>`;
}

function planningErrorCard(session) {
  const diagnostic = diagnosticFor(session.errorCode);
  const canRetry = state.planning?.providerAvailable;
  return `<article class="diagnostic error-severity" data-session-error="${esc(session.id)}">
    <div class="row"><div><p class="kicker">${esc(session.stage)} · ${formatDate(session.completedAt || session.updatedAt)}</p><h3>${esc(diagnostic.title)}</h3></div><span class="status error">error</span></div>
    <p>${esc(diagnostic.body)}</p>
    <div class="actions">
      ${diagnostic.action === "retry" || diagnostic.action === null ? `<button class="primary" data-planning-retry="${esc(session.id)}" ${canRetry ? "" : "disabled"}>${t("retry")}</button>` : ""}
      ${diagnostic.action === "auth_help" ? `<a class="button" href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noreferrer">${t("authHelp")}</a>` : ""}
      ${diagnostic.action === "open_settings" ? `<button data-go-tab="settings">${t("openSettings")}</button>` : ""}
      <button data-copy-session="${esc(session.id)}">${t("copyDiagnostic")}</button>
    </div>
    <details><summary>${t("technicalDetails")}</summary><pre>${esc(`${session.errorCode || "planning.error"}\n${session.errorDetail || "No detail"}`)}</pre></details>
  </article>`;
}

function planningOperation(session, events) {
  const sessionEvents = events.filter((event) => event.sessionId === session.id);
  return `<div class="operation-progress"><div class="row"><strong>${esc(session.stage)}</strong><span class="status ${esc(session.status)}">${esc(session.status)}</span></div>
    <div class="event-list">${sessionEvents.slice(-6).map((event) => `<small><span>${esc(event.type)}</span>${esc(eventSummary(event.payload))}</small>`).join("") || '<small>Queued durably; waiting for the scheduler.</small>'}</div>
    <button data-planning-cancel="${esc(session.id)}">Cancel</button></div>`;
}

function eventSummary(payload) {
  if (payload.type === "assistant_message") return payload.text.slice(0, 100);
  if (payload.type === "error" || payload.type === "warning") return payload.message;
  if (payload.type === "completed") return payload.summary || (payload.success ? "completed" : "failed");
  if (payload.type === "tool_call") return payload.name;
  return "";
}

function artifactBadges(artifact) {
  return `<span class="badge ${esc(artifact.status)}">${esc(artifact.status)}</span>${artifact.confirmedAt ? '<span class="badge confirmed">confirmed</span>' : ""}`;
}

function planningArtifact(artifact) {
  const predecessor = artifact.predecessorArtifactId ? ` · from ${esc(artifact.predecessorArtifactId.slice(0, 8))}` : "";
  let body = "";
  if (artifact.kind === "interrogation") {
    const messages = artifact.content?.messages;
    body = `<p>${esc(Array.isArray(messages) ? `${messages.length} approved transcript messages` : artifact.content?.markdown || "Conversation snapshot")}</p>`;
  } else if (artifact.kind === "spec") {
    body = `<h4>${esc(artifact.content?.title)}</h4><p>${esc(artifact.content?.summary)}</p><small>${artifact.content?.requirements?.length || 0} requirements · ${artifact.content?.acceptanceCriteria?.length || 0} acceptance criteria</small>`;
  } else {
    body = `<div class="mini-ticket-list">${(artifact.content?.tickets || []).map((ticket) => `<span><strong>${esc(ticket.id)}</strong> ${esc(ticket.title)}${ticket.predecessorIds.length ? ` ← ${ticket.predecessorIds.map(esc).join(", ")}` : ""}</span>`).join("")}</div>`;
  }
  return `<article class="card artifact-card"><div class="row"><div><h3>${esc(artifact.kind)} v${artifact.revision}</h3><small class="muted">${esc(artifact.authorRole)}${predecessor}</small></div><div class="badges">${artifactBadges(artifact)}</div></div>${body}<div class="actions">${artifact.status === "draft" ? `<button data-artifact-approve="${esc(artifact.id)}">Approve this revision</button>` : ""}${artifact.kind === "tickets" && artifact.status === "approved" ? `<button class="primary" data-confirm-plan="${esc(artifact.id)}">${artifact.confirmedAt ? "DAG confirmed" : "Confirm DAG and create tickets"}</button>` : ""}</div></article>`;
}

function specListField(label, id, values) {
  return `<label>${esc(label)} <small>one per line</small><textarea id="${id}">${esc((values || []).join("\n"))}</textarea></label>`;
}

function ticketPlanRow(ticket) {
  return `<div class="ticket-plan-row">
    <div class="row"><strong>Ticket</strong><button data-remove-plan-ticket title="Remove row">Remove</button></div>
    <label>ID<input data-plan-id value="${esc(ticket.id)}" placeholder="stable-ticket-id"></label>
    <label>Title<input data-plan-title value="${esc(ticket.title)}" placeholder="Vertical slice"></label>
    <label>Description<textarea data-plan-description placeholder="End-to-end outcome">${esc(ticket.description)}</textarea></label>
    <label>Predecessor IDs <small>comma separated</small><input data-plan-predecessors value="${esc((ticket.predecessorIds || []).join(", "))}" placeholder="ticket-a, ticket-b"></label>
  </div>`;
}

function lines(selector) {
  return $(selector).value.split("\n").map((value) => value.trim()).filter(Boolean);
}

function readTicketPlanRows() {
  return [...document.querySelectorAll(".ticket-plan-row")].map((row) => ({
    id: row.querySelector("[data-plan-id]").value.trim(),
    title: row.querySelector("[data-plan-title]").value.trim(),
    description: row.querySelector("[data-plan-description]").value.trim(),
    predecessorIds: row.querySelector("[data-plan-predecessors]").value.split(",").map((value) => value.trim()).filter(Boolean),
  }));
}

const preparationStrategies = ["pnpm", "npm", "yarn", "bun", "uv", "poetry", "pipenv", "cargo", "go", "bash", "pwsh"];

function preparationUnitRow(unit = { root: ".", strategy: "pnpm" }) {
  const shell = ["bash", "pwsh"].includes(unit.strategy);
  return `<div class="ticket-plan-row" data-preparation-unit>
    <div class="row"><strong>Preparation unit</strong><div class="actions"><button data-preparation-up title="Move up">↑</button><button data-preparation-down title="Move down">↓</button><button data-remove-preparation title="Remove unit">Remove</button></div></div>
    <label>Repository-relative root<input data-preparation-root value="${esc(unit.root || ".")}" placeholder="packages/api"></label>
    <label>Strategy<select data-preparation-strategy>${preparationStrategies.map((strategy) => `<option value="${strategy}" ${strategy === unit.strategy ? "selected" : ""}>${strategy}</option>`).join("")}</select></label>
    <label data-preparation-shell class="${shell ? "" : "hidden"}">Tracked script<input data-preparation-script value="${esc(unit.script || "")}" placeholder="scripts/prepare.sh"></label>
    <label data-preparation-shell class="${shell ? "" : "hidden"}">Literal arguments <small>one per line; never interpolated by a shell</small><textarea data-preparation-args>${esc((unit.args || []).join("\n"))}</textarea></label>
  </div>`;
}

function readPreparationConfig() {
  if ($("#preparation-mode").value === "auto") return { mode: "auto" };
  return {
    mode: "explicit",
    units: [...document.querySelectorAll("[data-preparation-unit]")].map((row) => {
      const strategy = row.querySelector("[data-preparation-strategy]").value;
      const unit = { root: row.querySelector("[data-preparation-root]").value.trim(), strategy };
      if (["bash", "pwsh"].includes(strategy)) {
        unit.script = row.querySelector("[data-preparation-script]").value.trim();
        unit.args = row.querySelector("[data-preparation-args]").value.split("\n").map((value) => value.trim()).filter(Boolean);
      }
      return unit;
    }),
  };
}

function syncPreparationEditor() {
  const explicit = $("#preparation-mode")?.value === "explicit";
  $("#preparation-unit-editor")?.classList.toggle("hidden", !explicit);
  $("#add-preparation-unit")?.classList.toggle("hidden", !explicit);
  if (explicit && document.querySelectorAll("[data-preparation-unit]").length === 0) {
    $("#preparation-unit-editor").insertAdjacentHTML("beforeend", preparationUnitRow());
  }
}

function renderDetectedPreparation(preparation) {
  if (preparation.diagnostic) return `<p class="error">${esc(preparation.diagnostic.code)} · ${esc(preparation.diagnostic.error)}</p>`;
  const plan = preparation.detectedPlan;
  if (!plan?.applicable) return '<p class="muted">No preparation applies to this project.</p>';
  return `<div class="ticket-plan-rows">${plan.units.map((unit) => `<article class="target"><span><strong>${esc(unit.strategy)} · ${esc(unit.root)}</strong><small>${unit.commands.map((command) => esc(command.display)).join("<br>")}</small><small>${esc(unit.executablePath || "tool unavailable")} · ${esc(unit.toolVersion)}</small></span></article>`).join("")}</div><small class="muted">Fingerprint ${esc(plan.fingerprint)}</small>`;
}

function verificationUnitRow(unit = { root: ".", strategy: "pnpm" }) {
  const shell = ["bash", "pwsh"].includes(unit.strategy);
  return `<div class="ticket-plan-row" data-verification-unit>
    <div class="row"><strong>Verification unit</strong><div class="actions"><button data-verification-up title="Move up">↑</button><button data-verification-down title="Move down">↓</button><button data-remove-verification title="Remove unit">Remove</button></div></div>
    <label>Repository-relative root<input data-verification-root value="${esc(unit.root || ".")}" placeholder="packages/api"></label>
    <label>Strategy<select data-verification-strategy>${preparationStrategies.map((strategy) => `<option value="${strategy}" ${strategy === unit.strategy ? "selected" : ""}>${strategy}</option>`).join("")}</select></label>
    <label data-verification-shell class="${shell ? "" : "hidden"}">Tracked script<input data-verification-script value="${esc(unit.script || "")}" placeholder="scripts/verify.sh"></label>
    <label data-verification-shell class="${shell ? "" : "hidden"}">Literal arguments <small>one per line; never interpolated by a shell</small><textarea data-verification-args>${esc((unit.args || []).join("\n"))}</textarea></label>
  </div>`;
}

function readVerificationConfig() {
  if ($("#verification-mode").value === "auto") return { mode: "auto" };
  return {
    mode: "explicit",
    units: [...document.querySelectorAll("[data-verification-unit]")].map((row) => {
      const strategy = row.querySelector("[data-verification-strategy]").value;
      const unit = { root: row.querySelector("[data-verification-root]").value.trim(), strategy };
      if (["bash", "pwsh"].includes(strategy)) {
        unit.script = row.querySelector("[data-verification-script]").value.trim();
        unit.args = row.querySelector("[data-verification-args]").value.split("\n").map((value) => value.trim()).filter(Boolean);
      }
      return unit;
    }),
  };
}

function syncVerificationEditor() {
  const explicit = $("#verification-mode")?.value === "explicit";
  $("#verification-unit-editor")?.classList.toggle("hidden", !explicit);
  $("#add-verification-unit")?.classList.toggle("hidden", !explicit);
  if (explicit && document.querySelectorAll("[data-verification-unit]").length === 0) {
    $("#verification-unit-editor").insertAdjacentHTML("beforeend", verificationUnitRow());
  }
}

function renderDetectedVerification(verification) {
  if (verification.diagnostic) return `<p class="error">${esc(verification.diagnostic.code)} · ${esc(verification.diagnostic.error)}</p>`;
  const plan = verification.detectedPlan;
  if (!plan?.applicable) return '<p class="error">No verification convention is configured. Ticket execution will remain blocked.</p>';
  return `<div class="ticket-plan-rows">${plan.units.map((unit) => `<article class="target"><span><strong>${esc(unit.strategy)} · ${esc(unit.root)}</strong><small>${unit.commands.map((command) => esc(command.display)).join("<br>")}</small><small>${esc(unit.executablePath || "tool unavailable")} · ${esc(unit.toolVersion)}</small></span></article>`).join("")}</div><small class="muted">Fingerprint ${esc(plan.fingerprint)}</small>`;
}

function renderTickets() {
  content.className = "stack";
  content.innerHTML = `<div class="grid">${state.tickets.map(ticketCard).join("") || '<div class="empty">No tickets.</div>'}</div><article class="card"><h3>Create ticket</h3><input id="ticket-title" placeholder="Title"><textarea id="ticket-description" placeholder="What this vertical slice delivers"></textarea><input id="ticket-predecessors" placeholder="Predecessor ids, comma separated"><button id="create-ticket" class="primary">Create</button></article>`;
}

function renderDag() {
  content.className = "stack";
  content.innerHTML = `<p class="muted">Read-only dependency graph. Only DONE satisfies an edge.</p><div class="dag">${state.tickets.map((ticket) => { const blockers = state.dependencies.filter((edge) => edge.ticketId === ticket.id).map((edge) => edge.predecessorId); return `<article class="card node"><div class="row"><strong>${esc(ticket.title)}</strong><span class="status ${esc(ticket.status)}">${esc(ticket.status)}</span></div><p class="edge">blocked by: ${blockers.map(esc).join(", ") || "none"}</p></article>`; }).join("")}</div>`;
}

function renderActivity() {
  content.className = "stack";
  const items = state.activity?.items ?? [];
  content.innerHTML = `<section><div class="row"><div><p class="kicker">${t("activity")}</p><h2>${state.activity?.summary?.count ?? 0} ${t("attention")}</h2></div></div>
    <div class="activity-list">${items.map((item) => {
      const diagnostic = diagnosticFor(item.code);
      const title = item.severity === "info" ? item.title : diagnostic.title;
      return `<article class="activity-item ${esc(item.severity)} ${item.resolved ? "resolved" : ""}">
        <span class="activity-marker" aria-hidden="true"></span><div><div class="row"><strong>${esc(title)}</strong><time datetime="${esc(item.occurredAt)}">${formatDate(item.occurredAt)}</time></div>
        <p>${esc(item.severity === "info" ? item.detail || item.status : diagnostic.body)}</p>
        <small>${esc(item.source)} · ${esc(item.status)}${item.code ? ` · ${esc(item.code)}` : ""}${item.resolved ? " · resolved" : ""}</small>
        ${item.detail && item.severity !== "info" ? `<details><summary>${t("technicalDetails")}</summary><pre>${esc(item.detail)}</pre></details>` : ""}
        <div class="actions">${activityAction(item)}</div></div>
      </article>`;
    }).join("") || `<div class="empty">${t("noActivity")}</div>`}</div></section>`;
}

function activityAction(item) {
  if (item.resolved) return "";
  if (item.action === "retry_planning" && item.sessionId) return `<button data-planning-retry="${esc(item.sessionId)}">${t("retry")}</button>`;
  if (item.action === "resume_planning" && item.sessionId) return `<button data-planning-resume="${esc(item.sessionId)}">${t("resume")}</button>`;
  if (item.action === "open_ticket" && item.ticketId) return `<button data-open-ticket="${esc(item.ticketId)}">${t("openTicket")}</button>`;
  if (item.action === "open_settings" || item.action === "approve_preparation") return `<button data-go-tab="settings">${t("openSettings")}</button>`;
  if (item.action === "confirm_integration" && item.ticketId) return `<button data-open-ticket="${esc(item.ticketId)}">${t("openTicket")}</button>`;
  return "";
}

function renderProgress() {
  const artifacts = state.planning?.artifacts ?? [];
  const steps = [
    { key: "ideaPlan", active: state.tab === "planning", done: artifacts.some((item) => item.kind === "tickets" && item.confirmedAt) },
    { key: "tickets", active: ["tickets", "dag"].includes(state.tab), done: state.tickets.length > 0 },
    { key: "execution", active: ["overview", "history", "sessions"].includes(state.tab), done: state.tickets.length > 0 && state.tickets.every((ticket) => ticket.status === "DONE") },
    { key: "integration", active: false, done: state.tickets.length > 0 && state.tickets.every((ticket) => ticket.status === "DONE") },
  ];
  $("#progress").innerHTML = steps.map((step, index) => `<span class="progress-step ${step.done ? "done" : ""} ${step.active ? "active" : ""}"><i>${step.done ? "✓" : index + 1}</i>${t(step.key)}</span>`).join("");
}

async function renderHistory() {
  content.className = "stack";
  content.innerHTML = '<div class="empty">Loading history…</div>';
  const rows = await Promise.all(state.tickets.map(async (ticket) => ({
    ticket,
    data: await json(`${base()}/tickets/${encodeURIComponent(ticket.id)}/history`),
    preparation: await json(`${base()}/tickets/${encodeURIComponent(ticket.id)}/preparation`),
    verification: await json(`${base()}/tickets/${encodeURIComponent(ticket.id)}/verification`),
  })));
  content.innerHTML = rows.map(({ ticket, data, preparation, verification }) => `<article class="card"><h3>${esc(ticket.title)}</h3><pre>${esc(data.history.map((entry) => `${entry.createdAt}  ${entry.fromStatus || "∅"} → ${entry.toStatus}  ${entry.reason}`).join("\n"))}</pre>${preparation.attempts.length ? `<h4>Workspace preparation</h4><pre>${esc(JSON.stringify(preparation.attempts, null, 2))}</pre>` : ""}${verification.attempts.length ? `<h4>Workspace verification</h4><pre>${esc(JSON.stringify(verification.attempts, null, 2))}</pre>` : ""}</article>`).join("") || '<div class="empty">No history.</div>';
}

async function renderSessions() {
  content.className = "stack";
  content.innerHTML = '<div class="empty">Loading sessions…</div>';
  const rows = await Promise.all(state.tickets.map(async (ticket) => ({ ticket, data: await json(`${base()}/tickets/${encodeURIComponent(ticket.id)}/sessions`) })));
  content.innerHTML = rows.map(({ ticket, data }) => `<article class="card"><h3>${esc(ticket.title)}</h3><pre>${esc(JSON.stringify(data.sessions, null, 2))}</pre></article>`).join("") || '<div class="empty">No sessions.</div>';
}

async function renderSettings() {
  content.className = "stack";
  content.innerHTML = '<div class="empty">Loading settings…</div>';
  const [settings, preparation, verification] = await Promise.all([json(`${base()}/settings`), json(`${base()}/preparation`), json(`${base()}/verification`)]);
  const units = preparation.config.mode === "explicit" ? preparation.config.units || [] : [];
  const verificationUnits = verification.config.mode === "explicit" ? verification.config.units || [] : [];
  const effective = settings?.effective;
  content.innerHTML = `<article class="card"><div class="row"><div><p class="kicker">Agent policy</p><h3>Project configuration</h3></div><small class="muted">Saved as a validated project override</small></div>
    <div class="settings-grid"><label>Integration<select id="settings-integration"><option value="auto" ${effective?.integrationMode === "auto" ? "selected" : ""}>Automatic after review</option><option value="confirm" ${effective?.integrationMode === "confirm" ? "selected" : ""}>Always confirm</option></select></label>
    <label>Review<select id="settings-review"><option value="independent" ${effective?.reviewMode === "independent" ? "selected" : ""}>Independent session</option><option value="self" ${effective?.reviewMode === "self" ? "selected" : ""}>Self review</option></select></label></div>
    <div class="stage-table">${Object.entries(effective?.stages || {}).map(([stage, value]) => stageSettingsRow(stage, value)).join("")}</div>
    <button id="save-settings" class="primary">Validate and save</button>
    <details><summary>Raw effective configuration</summary><pre>${esc(JSON.stringify(effective, null, 2))}</pre></details>
  </article><article class="card"><h3>Workspace preparation</h3><p>Auto-detection handles one unambiguous root stack. Mixed repositories use ordered units; shell steps must point to tracked Bash or PowerShell files.</p><label>Detection mode<select id="preparation-mode"><option value="auto" ${preparation.config.mode === "auto" ? "selected" : ""}>Auto-detect root stack</option><option value="explicit" ${preparation.config.mode === "explicit" ? "selected" : ""}>Explicit ordered units</option></select></label><div id="preparation-unit-editor" class="ticket-plan-rows ${preparation.config.mode === "explicit" ? "" : "hidden"}">${units.map(preparationUnitRow).join("")}</div><div class="actions"><button id="add-preparation-unit" class="${preparation.config.mode === "explicit" ? "" : "hidden"}">Add unit</button><button id="save-preparation" class="primary">Save preparation</button><button id="revoke-preparation" ${preparation.approval ? "" : "disabled"}>Revoke approval</button></div>${renderDetectedPreparation(preparation)}</article>
  <article class="card"><h3>Workspace verification</h3><p>Verification runs after implementation and before review. Mixed repositories use ordered units; unknown conventions block instead of guessing.</p><label>Detection mode<select id="verification-mode"><option value="auto" ${verification.config.mode === "auto" ? "selected" : ""}>Auto-detect root stack</option><option value="explicit" ${verification.config.mode === "explicit" ? "selected" : ""}>Explicit ordered units</option></select></label><div id="verification-unit-editor" class="ticket-plan-rows ${verification.config.mode === "explicit" ? "" : "hidden"}">${verificationUnits.map(verificationUnitRow).join("")}</div><div class="actions"><button id="add-verification-unit" class="${verification.config.mode === "explicit" ? "" : "hidden"}">Add unit</button><button id="save-verification" class="primary">Save verification</button><button id="revoke-verification" ${verification.approval ? "" : "disabled"}>Revoke approval</button></div>${renderDetectedVerification(verification)}</article>
  <article class="card"><h3>Future Auto mode</h3><p>Automatic sequential ticket execution is planned as an opt-in feature. Manual Run remains the default.</p></article><article class="card"><h3>Safe cleanup</h3><p>Preview registered worktrees, branches, metadata and global registration before deleting anything.</p><button id="plan-cleanup" class="danger-button">Build cleanup plan</button></article>`;
}

function stageSettingsRow(stage, selected) {
  const models = state.capabilities?.models ?? [];
  const model = models.find((item) => item.id === selected.model) ?? models[0];
  const efforts = model?.efforts ?? [];
  return `<fieldset data-settings-stage="${esc(stage)}"><legend>${esc(stage)}</legend>
    <label>Provider<input data-stage-provider value="${esc(state.capabilities?.provider || selected.provider)}" readonly></label>
    <label>Model<select data-stage-model>${models.map((item) => `<option value="${esc(item.id)}" ${item.id === selected.model ? "selected" : ""}>${esc(item.id)}</option>`).join("")}</select></label>
    <label>Effort<select data-stage-effort><option value="">Not applicable</option>${efforts.map((effort) => `<option value="${esc(effort)}" ${effort === selected.effort ? "selected" : ""}>${esc(effort)}</option>`).join("")}</select></label>
  </fieldset>`;
}

function readSettingsOverride() {
  return {
    integrationMode: $("#settings-integration").value,
    reviewMode: $("#settings-review").value,
    stages: Object.fromEntries([...document.querySelectorAll("[data-settings-stage]")].map((row) => [
      row.dataset.settingsStage,
      {
        provider: row.querySelector("[data-stage-provider]").value,
        model: row.querySelector("[data-stage-model]").value,
        effort: row.querySelector("[data-stage-effort]").value || null,
      },
    ])),
  };
}

async function showWorkspaceApproval(error, request) {
  const plan = error.details?.plan;
  if (!plan) throw error;
  const sourceKind = error.code.startsWith("verification.") ? "verification" : "preparation";
  const ticketVerification = sourceKind === "preparation"
    ? await json(`${base()}/tickets/${encodeURIComponent(request.ticketId)}/verification`)
    : null;
  const verificationPlan = ticketVerification?.detectedPlan ?? null;
  const includeVerification = verificationPlan?.applicable
    && verificationPlan.units.every((unit) => unit.toolAvailable)
    && state.verification?.approval?.fingerprint !== verificationPlan.fingerprint;
  const kind = includeVerification ? "combined" : sourceKind;
  state.pendingWorkspaceAction = {
    request,
    kind,
    ...(sourceKind === "preparation" ? { preparationFingerprint: plan.fingerprint } : { verificationFingerprint: plan.fingerprint }),
    ...(includeVerification ? { verificationFingerprint: verificationPlan.fingerprint } : {}),
  };
  $("#workspace-approval-title").textContent = kind === "combined"
    ? "Allow workspace setup and verification?"
    : kind === "verification" ? "Allow project verification?" : "Allow reproducible setup?";
  $("#workspace-approval-description").textContent = kind === "combined"
    ? "Setup may use the network or install scripts. Verification executes the commands shown after implementation and before review."
    : kind === "verification"
      ? "These commands execute project code after implementation and before review."
      : "These commands may use the network and execute dependency or project install scripts.";
  const renderPlan = (label, current) => `<section class="stack"><strong>${esc(label)}</strong>${current.units.map((unit) => `<article class="target"><span><strong>${esc(unit.strategy)} · ${esc(unit.root)}</strong><small>${unit.commands.map((command) => esc(command.display)).join("<br>")}</small><small>${esc(unit.executablePath || "tool unavailable")} · ${esc(unit.toolVersion)}</small></span></article>`).join("")}</section>`;
  $("#workspace-approval-commands").innerHTML = [
    sourceKind === "preparation" ? renderPlan("Preparation", plan) : "",
    sourceKind === "verification" ? renderPlan("Verification", plan) : "",
    includeVerification ? renderPlan("Verification", verificationPlan) : "",
  ].join("");
  $("#workspace-approval-fingerprint").textContent = [
    sourceKind === "preparation" ? `Preparation fingerprint ${plan.fingerprint}` : "",
    sourceKind === "verification" ? `Verification fingerprint ${plan.fingerprint}` : "",
    includeVerification ? `Verification fingerprint ${verificationPlan.fingerprint}` : "",
  ].filter(Boolean).join(" · ");
  $("#workspace-approval-dialog").showModal();
}

async function executeTicketAction(ticketId, body) {
  try {
    return await json(`${base()}/tickets/${encodeURIComponent(ticketId)}/actions`, mutation(body));
  } catch (error) {
    if (["preparation.approval_required", "preparation.plan_changed", "verification.approval_required", "verification.plan_changed"].includes(error.code)) {
      await showWorkspaceApproval(error, {
        ticketId,
        body: error.details?.purpose === "integration" ? { ...body, action: "retry" } : body,
      });
      return null;
    }
    throw error;
  }
}

async function refreshPreview() {
  if (!state.project || !$("#preview")) return;
  const active = state.tickets.find((ticket) => ["RUNNING", "REVIEW", "CHANGES_REQUESTED", "READY_TO_MERGE"].includes(ticket.status));
  const status = await json(`${base()}/preview${active ? `?ticketId=${encodeURIComponent(active.id)}` : ""}`);
  if (!$("#preview")) return;
  $("#preview").innerHTML = status.url && status.running ? `<iframe class="preview-frame" src="${esc(status.url)}"></iframe>` : `<pre>${esc(status.diagnostic || status.logs || `Source: ${status.source}\n${status.root}`)}</pre>`;
}

async function action(operation, refresh = true) {
  clearNotice();
  try {
    await operation();
    if (refresh && state.project) await refreshProject();
  } catch (error) {
    showNotice(error);
  }
}

function clearNotice() {
  state.notice = null;
  errorBox.classList.remove("visible");
  errorBox.innerHTML = "";
}

function showNotice(error) {
  const code = error.code || "internal.error";
  const diagnostic = diagnosticFor(code);
  state.notice = { code, message: error.message };
  errorBox.classList.add("visible");
  errorBox.innerHTML = `<div><strong>${esc(diagnostic.title)}</strong><p>${esc(diagnostic.body)}</p><details><summary>${t("technicalDetails")}</summary><pre>${esc(`${code}\n${error.message}`)}</pre></details></div><button id="dismiss-error" aria-label="${t("dismiss")}">×</button>`;
}

function selectTab(tab) {
  state.tab = tab;
  document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item.dataset.tab === tab));
  render();
  if (tab === "activity") void refreshProject().catch(showNotice);
}

function openWizard(mode, path = "") {
  state.wizardInspection = null;
  $("#project-form").reset();
  $("#new-project-path").value = path;
  $("#inspection").textContent = mode === "create" ? "Choose a missing or empty directory for the new project." : "Choose any folder; raycoder will inspect it before proposing an operation.";
  $("#save-project").disabled = true;
  $("#project-dialog").showModal();
  if (path) void inspectWizard();
}

async function inspectWizard() {
  const path = $("#new-project-path").value.trim();
  if (!path) throw new Error("Enter a folder path first");
  const inspection = await json("/api/projects/inspect", mutation({ path }));
  state.wizardInspection = inspection;
  const operation = operationFor(inspection);
  $("#inspection").className = `inspection operation ${operation ? "" : "warn"}`;
  $("#inspection").innerHTML = `<strong>${esc(inspection.kind.replaceAll("_", " "))}</strong><p>${esc(operation?.description || inspection.diagnostics.map((item) => item.message).join(" ") || "This path cannot be used.")}</p>${inspection.canonicalPath ? `<small>${esc(inspection.canonicalPath)}</small>` : ""}`;
  $("#save-project").disabled = !operation;
  $("#save-project").textContent = operation?.label || "Unavailable";
}

function operationFor(inspection) {
  if (inspection.kind === "git_repository" && inspection.canRegister) return { action: "register", label: "Open repository", description: "Register this repository and open an isolated project runtime. No tracked files will be changed." };
  if ((inspection.kind === "missing" || inspection.kind === "empty_directory") && inspection.canCreate) return { action: "create", label: "Create project", description: "Create the directory if needed, run git init -b main, then create one empty root commit as raycoder <raycoder@local.invalid>. Git configuration will not be modified." };
  if (inspection.kind === "non_git_directory" && inspection.canInitialize) return { action: "initialize", label: "Initialize Git only", description: "Run git init -b main only. Existing files will not be staged or committed; tickets stay disabled until you create a baseline commit." };
  return null;
}

async function confirmWizard() {
  const inspection = state.wizardInspection;
  const operation = inspection && operationFor(inspection);
  if (!inspection || !operation) throw new Error("Inspect a supported path before confirming");
  const result = await json("/api/projects", mutation({
    action: operation.action,
    path: inspection.canonicalPath || inspection.requestedPath,
    name: $("#new-project-name").value.trim() || undefined,
    confirmGitInit: operation.action !== "register",
  }));
  $("#project-dialog").close();
  state.projects = result.projects;
  const chosen = result.projects[0];
  renderProjects();
  if (chosen) await selectProject(chosen.project.id);
}

async function buildCleanupPlan() {
  state.cleanupPlan = await json(`${base()}/cleanup/plan`, mutation({}));
  const plan = state.cleanupPlan;
  $("#cleanup-targets").innerHTML = plan.targets.map((target) => `<label class="target"><input type="checkbox" data-cleanup-target="${esc(target.id)}" ${target.selectedByDefault ? "checked" : ""}><span><strong>${esc(target.label)}</strong><small>${esc(target.path || target.branch || target.kind)}${target.requiresForce ? " · force required" : ""}</small></span></label>`).join("");
  $("#cleanup-warnings").textContent = plan.warnings.map((warning) => warning.message).join("\n");
  $("#cleanup-phrase").value = "";
  $("#cleanup-force").checked = false;
  $("#cleanup-phrase").placeholder = plan.confirmationPhrase;
  $("#cleanup-dialog").showModal();
}

async function executeCleanup() {
  const plan = state.cleanupPlan;
  if (!plan) throw new Error("Generate a cleanup plan first");
  const selectedTargetIds = [...document.querySelectorAll("[data-cleanup-target]:checked")].map((input) => input.dataset.cleanupTarget);
  const result = await json(`${base()}/cleanup/execute`, mutation({
    planId: plan.id,
    fingerprint: plan.fingerprint,
    confirmationPhrase: $("#cleanup-phrase").value,
    selectedTargetIds,
    force: $("#cleanup-force").checked,
  }));
  if (!result.complete) throw new Error(`${result.failedStep}: ${result.error}`);
  $("#cleanup-dialog").close();
  state.project = null;
  await loadGlobal();
  showLanding();
}

$("#projects").addEventListener("click", (event) => {
  const button = event.target.closest("[data-project]");
  if (button) void action(() => selectProject(button.dataset.project), false);
});
$("#content").addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.goTab) { selectTab(target.dataset.goTab); return; }
  if (target.dataset.project) { void action(() => selectProject(target.dataset.project), false); return; }
  if (target.dataset.onboard) { openWizard(target.dataset.onboard); return; }
  if (target.id === "refresh-preflight") { void action(async () => { state.preflight = await json("/api/preflight/refresh", mutation({})); renderHealth(); showLanding(); }, false); return; }
  if (!state.project) return;
  if (target.dataset.planningRetry) { void action(() => json(`${base()}/planning/sessions/${encodeURIComponent(target.dataset.planningRetry)}/actions`, mutation({ action: "retry" }))); return; }
  if (target.dataset.copySession) {
    const session = state.planning?.sessions.find((candidate) => candidate.id === target.dataset.copySession);
    if (session) void navigator.clipboard.writeText(`${session.errorCode || "planning.error"}\n${session.errorDetail || "No detail"}`).then(() => { target.textContent = t("copied"); });
    return;
  }
  if (target.dataset.openTicket) { selectTab("tickets"); return; }
  if (target.dataset.ticketAction) {
    void action(async () => {
      const body = { action: target.dataset.ticketAction };
      if (body.action === "confirm") body.attemptId = target.dataset.attempt;
      if (["run", "retry"].includes(body.action)) {
        if (!state.inspection.hasBaseCommit) throw new Error("Create a baseline commit before running tickets");
        if (state.inspection.dirty) {
          const proceed = window.confirm("The main checkout is dirty. Continue from committed HEAD? Local changes will stay outside the ticket workspace.");
          if (!proceed) return;
          body.dirtyPolicy = "committed-head";
        } else body.dirtyPolicy = "cancel";
      }
      await executeTicketAction(target.dataset.ticket, body);
    });
    return;
  }
  if (target.id === "create-ticket") { void action(() => json(`${base()}/tickets`, mutation({ title: $("#ticket-title").value, description: $("#ticket-description").value, predecessorIds: $("#ticket-predecessors").value.split(",").map((item) => item.trim()).filter(Boolean) }))); return; }
  if (target.id === "send-planning-message") { void action(() => json(`${base()}/planning/messages`, mutation({ content: $("#planning-message").value }))); return; }
  if (target.id === "generate-spec") { void action(() => json(`${base()}/planning/generations`, mutation({ stage: "spec" }))); return; }
  if (target.id === "generate-tickets") {
    const approved = state.planning.artifacts.filter((artifact) => artifact.kind === "spec" && artifact.status === "approved").at(-1);
    void action(() => json(`${base()}/planning/generations`, mutation({ stage: "tickets", predecessorArtifactId: approved?.id })));
    return;
  }
  if (target.dataset.planningCancel) { void action(() => json(`${base()}/planning/sessions/${encodeURIComponent(target.dataset.planningCancel)}/actions`, mutation({ action: "cancel" }))); return; }
  if (target.dataset.planningResume) { void action(() => json(`${base()}/planning/sessions/${encodeURIComponent(target.dataset.planningResume)}/actions`, mutation({ action: "resume" }))); return; }
  if (target.dataset.artifactApprove) { void action(() => json(`${base()}/planning/artifacts/${encodeURIComponent(target.dataset.artifactApprove)}/actions`, mutation({ action: "approve" }))); return; }
  if (target.id === "save-spec") {
    const previous = state.planning.artifacts.filter((artifact) => artifact.kind === "spec").at(-1);
    void action(() => json(`${base()}/planning/specs`, mutation({
      predecessorArtifactId: $("#spec-predecessor").value,
      replacesArtifactId: previous?.id,
      content: {
        title: $("#spec-title").value,
        summary: $("#spec-summary").value,
        goals: lines("#spec-goals"),
        nonGoals: lines("#spec-non-goals"),
        requirements: lines("#spec-requirements"),
        acceptanceCriteria: lines("#spec-acceptance"),
        constraints: lines("#spec-constraints"),
      },
    })));
    return;
  }
  if (target.id === "add-plan-ticket") { $("#ticket-plan-rows").insertAdjacentHTML("beforeend", ticketPlanRow({ id: "", title: "", description: "", predecessorIds: [] })); return; }
  if (target.dataset.removePlanTicket !== undefined) { target.closest(".ticket-plan-row")?.remove(); return; }
  if (target.id === "save-ticket-plan") {
    const previous = state.planning.artifacts.filter((artifact) => artifact.kind === "tickets").at(-1);
    void action(() => json(`${base()}/planning/ticket-plans`, mutation({
      predecessorArtifactId: $("#ticket-spec").value,
      replacesArtifactId: previous?.id,
      tickets: readTicketPlanRows(),
    })));
    return;
  }
  if (target.dataset.confirmPlan) { void action(() => json(`${base()}/planning/dag/confirm`, mutation({ artifactId: target.dataset.confirmPlan }))); return; }
  if (target.id === "save-settings") { void action(() => json(`${base()}/settings`, mutation({ override: readSettingsOverride() }))); return; }
  if (target.id === "add-preparation-unit") { $("#preparation-unit-editor").insertAdjacentHTML("beforeend", preparationUnitRow()); return; }
  if (target.dataset.removePreparation !== undefined) { target.closest("[data-preparation-unit]")?.remove(); return; }
  if (target.dataset.preparationUp !== undefined) { const row = target.closest("[data-preparation-unit]"); if (row?.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling); return; }
  if (target.dataset.preparationDown !== undefined) { const row = target.closest("[data-preparation-unit]"); if (row?.nextElementSibling) row.parentElement.insertBefore(row.nextElementSibling, row); return; }
  if (target.id === "save-preparation") { void action(() => json(`${base()}/preparation/config`, mutationMethod("PUT", readPreparationConfig()))); return; }
  if (target.id === "revoke-preparation") { void action(() => json(`${base()}/preparation/approval`, mutationMethod("DELETE"))); return; }
  if (target.id === "add-verification-unit") { $("#verification-unit-editor").insertAdjacentHTML("beforeend", verificationUnitRow()); return; }
  if (target.dataset.removeVerification !== undefined) { target.closest("[data-verification-unit]")?.remove(); return; }
  if (target.dataset.verificationUp !== undefined) { const row = target.closest("[data-verification-unit]"); if (row?.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling); return; }
  if (target.dataset.verificationDown !== undefined) { const row = target.closest("[data-verification-unit]"); if (row?.nextElementSibling) row.parentElement.insertBefore(row.nextElementSibling, row); return; }
  if (target.id === "save-verification") { void action(() => json(`${base()}/verification/config`, mutationMethod("PUT", readVerificationConfig()))); return; }
  if (target.id === "revoke-verification") { void action(() => json(`${base()}/verification/approval`, mutationMethod("DELETE"))); return; }
  if (target.id === "plan-cleanup") { void action(buildCleanupPlan, false); return; }
  if (target.dataset.preview) { const active = state.tickets.find((ticket) => ["RUNNING", "REVIEW", "CHANGES_REQUESTED", "READY_TO_MERGE"].includes(ticket.status)); void action(() => json(`${base()}/preview`, mutation({ action: target.dataset.preview, ticketId: active?.id }))); }
});
$("#content").addEventListener("change", (event) => {
  if (event.target.id === "preparation-mode") { syncPreparationEditor(); return; }
  if (event.target.id === "verification-mode") { syncVerificationEditor(); return; }
  if (event.target.matches("[data-preparation-strategy]")) {
    const row = event.target.closest("[data-preparation-unit]");
    const shell = ["bash", "pwsh"].includes(event.target.value);
    row?.querySelectorAll("[data-preparation-shell]").forEach((field) => field.classList.toggle("hidden", !shell));
    return;
  }
  if (event.target.matches("[data-verification-strategy]")) {
    const row = event.target.closest("[data-verification-unit]");
    const shell = ["bash", "pwsh"].includes(event.target.value);
    row?.querySelectorAll("[data-verification-shell]").forEach((field) => field.classList.toggle("hidden", !shell));
  }
});
$("#nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (!button) return;
  selectTab(button.dataset.tab);
});
$("#error").addEventListener("click", (event) => { if (event.target.closest("#dismiss-error")) clearNotice(); });
$("#locale-select").addEventListener("change", () => void savePreferences());
$("#theme-select").addEventListener("change", () => void savePreferences());
$("#home").addEventListener("click", showLanding);
$("#add-project").addEventListener("click", () => openWizard("existing"));
$("#inspect-project").addEventListener("click", () => void action(inspectWizard, false));
$("#save-project").addEventListener("click", () => void action(confirmWizard, false));
$("#browse-project").addEventListener("click", () => void action(async () => {
  const result = await json("/api/system/directory-picker", mutation({}));
  if (result.status === "selected") { $("#new-project-path").value = result.path; await inspectWizard(); }
  else if (result.status === "unavailable") $("#inspection").textContent = `${result.diagnostic} Enter the path manually.`;
}, false));
$("#execute-cleanup").addEventListener("click", () => void action(executeCleanup, false));
$("#approve-workspace").addEventListener("click", () => void action(async () => {
  const pending = state.pendingWorkspaceAction;
  if (!pending) throw new Error("No workspace operation is awaiting approval");
  $("#workspace-approval-dialog").close();
  state.pendingWorkspaceAction = null;
  const approvals = {
    ...(pending.preparationFingerprint ? { preparationApproval: { fingerprint: pending.preparationFingerprint, allowNetwork: true, allowInstallScripts: true, rememberForProject: true } } : {}),
    ...(pending.verificationFingerprint ? { verificationApproval: { fingerprint: pending.verificationFingerprint, allowVerification: true, rememberForProject: true } } : {}),
  };
  await executeTicketAction(pending.request.ticketId, { ...pending.request.body, ...approvals });
}, false));

async function boot() {
  try {
    await loadGlobal();
    showLanding();
    const hashProject = new URLSearchParams(location.hash.slice(1)).get("project");
    const prefilledPath = new URL(location.href).searchParams.get("path");
    if (hashProject) await selectProject(hashProject);
    else if (prefilledPath) openWizard("existing", prefilledPath);
  } catch (error) {
    showNotice(error);
  }
}

async function savePreferences() {
  const preferences = { locale: $("#locale-select").value, theme: $("#theme-select").value };
  try {
    const result = await json("/api/preferences", mutationMethod("PUT", preferences));
    state.preferences = result.preferences;
    configurePreferences(state.preferences);
    renderChrome();
    renderProjects();
    if (state.project) render(); else showLanding();
  } catch (error) {
    showNotice(error);
  }
}

void boot();
setInterval(() => {
  if (state.project && ["overview", "tickets", "dag", "activity"].includes(state.tab)) void refreshProject().catch(showNotice);
}, 2500);

setInterval(() => {
  if (!state.project || state.tab !== "planning") return;
  void Promise.all([json(`${base()}/planning`), json(`${base()}/activity`)]).then(([planning, activity]) => {
    state.planning = planning;
    state.activity = activity;
    const entry = state.projects.find((candidate) => candidate.project.id === state.project.id);
    if (entry) entry.attention = activity.summary;
    renderProjects();
    const editing = content.contains(document.activeElement) && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (!editing) renderPlanning();
  }).catch(showNotice);
}, 1000);

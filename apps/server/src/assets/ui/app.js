import { json, mutation, mutationMethod } from "./api.js";
import { configurePreferences, formatDate, label, plural, t } from "./i18n.js";
import { diagnosticFor, esc, nextAction } from "./presentation.js";
import { state } from "./state.js";

const $ = (selector) => document.querySelector(selector);
const content = $("#content");
const errorBox = $("#error");
let pendingActions = 0;
let planningMessagePending = false;
let transcriptPinned = true;
let transcriptUnread = 0;

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
      <small>${esc(label("status", entry.state))} · ${esc(entry.project.path)}</small>
      ${entry.attention?.count ? `<span class="attention-badge ${esc(entry.attention.highestSeverity)}">${entry.attention.count} · ${t("attention")}</span>` : ""}
    </button>`).join("") || `<p class="muted">${t("noRecentProjects")}</p>`;
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
  document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => { node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel)); });
}

function renderHealth() {
  if (!state.preflight) return;
  const diagnostics = [
    ...state.preflight.essential.map((item) => ({ label: item.name, ok: item.ok, message: item.message })),
    ...state.preflight.tools.map((item) => ({ label: item.name, ok: item.ok, message: item.message })),
    ...state.preflight.providers.map((provider) => ({
      label: provider.provider,
      ok: provider.executable,
      message: provider.diagnostics.map((item) => item.message).join(" · ") || t(provider.executable ? "available" : "unavailable"),
    })),
    ...(state.memory ? [{
      label: "engram",
      ok: state.memory.available,
      message: state.memory.diagnostics.map((item) => item.message).join(" · "),
    }] : []),
  ];
  $("#health").innerHTML = diagnostics.map((item) => `<span class="pill ${item.ok ? "ok" : "bad"}" title="${esc(item.message)}">${esc(item.label)}</span>`).join(" ");
  $("#sidebar-health").textContent = t(state.preflight.canExecute ? "readyToExecute" : state.preflight.canServe ? "uiReadyAgentsDisabled" : "nodeUpgradeRequired");
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
    ? t("providerReadyNote")
    : t("providerDisabledNote");
  content.className = "hero";
  content.innerHTML = `
    <p class="kicker">${t("oneHostManyProjects")}</p>
    <h2>${t("landingTitle")}</h2>
    <p>${t("landingBody")} ${esc(providerNote)}</p>
    <div class="hero-actions"><button class="primary" data-onboard="existing">${t("openExistingFolder")}</button><button data-onboard="create">${t("createNewProject")}</button><button id="refresh-preflight">${t("refreshDiagnostics")}</button></div>
    <section><p class="kicker">${t("recentProjects")}</p><div class="grid">${state.projects.map((entry) => `
      <article class="card"><div class="row"><h3>${esc(entry.project.name)}</h3><span class="status">${esc(label("status", entry.state))}</span></div><p>${esc(entry.project.path)}</p>${entry.error ? `<p class="error">${esc(entry.error)}</p>` : ""}<button data-project="${esc(entry.project.id)}">${t("open")}</button></article>`).join("") || `<div class="empty">${t("recentProjectsEmpty")}</div>`}</div></section>
    <section><p class="kicker">${t("preflight")}</p><div class="grid">${preflightCards()}</div></section>`;
}

function preflightCards() {
  if (!state.preflight) return "";
  const cards = [
    ...state.preflight.essential,
    ...state.preflight.tools,
    ...state.preflight.providers.map((provider) => ({
      name: provider.provider,
      ok: provider.executable,
      message: provider.diagnostics.map((item) => item.message).join(" · ") || t("noDiagnostic"),
    })),
    ...(state.memory ? [{ name: "engram", ok: state.memory.available, message: state.memory.diagnostics.map((item) => item.message).join(" · ") }] : []),
  ];
  return cards.map((item) => `<article class="card"><div class="row"><h3>${esc(item.name)}</h3><span class="pill ${item.ok ? "ok" : "bad"}">${t(item.ok ? "ready" : "attention")}</span></div><p>${esc(item.message)}</p></article>`).join("");
}

async function selectProject(id) {
  let entry = state.projects.find((candidate) => candidate.project.id === id);
  if (!entry) return;
  if (!entry.open) {
    await json(`/api/projects/${encodeURIComponent(id)}/open`, mutation({}));
    await loadGlobal();
    entry = state.projects.find((candidate) => candidate.project.id === id);
  }
  if (!entry?.open) throw new Error(entry?.error || t("pathCannotBeUsed"));
  state.project = entry.project;
  state.projectEntry = entry;
  state.inspection = await json(`${base()}/inspection`);
  $("#nav").classList.remove("hidden");
  $("#view-kicker").textContent = t("project");
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
  const [ticketData, dependencyData, planning, capabilities, inspection, preparation, verification, activity, auto] = await Promise.all([
    json(`${base()}/tickets`), json(`${base()}/dependencies`), json(`${base()}/planning`), json(`${base()}/capabilities`), json(`${base()}/inspection`), json(`${base()}/preparation`), json(`${base()}/verification`), json(`${base()}/activity`), json(`${base()}/auto`),
  ]);
  state.tickets = ticketData.tickets;
  state.dependencies = dependencyData.dependencies;
  state.planning = planning;
  state.capabilities = capabilities;
  state.inspection = inspection;
  state.preparation = preparation;
  state.verification = verification;
  state.activity = activity;
  state.auto = auto;
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
  if (!state.inspection?.hasBaseCommit) return { allowed: false, reason: t("baselineRequired") };
  if (!state.preflight?.canExecute) return { allowed: false, reason: t("noExecutableProvider") };
  return { allowed: true, reason: "" };
}

function ticketCard(ticket) {
  const attempt = ticket.integrationAttempt;
  const allowed = eligibility().allowed;
  const buttons = [];
  if (ticket.status === "READY") buttons.push(`<button data-ticket-action="run" data-ticket="${esc(ticket.id)}" class="primary" ${allowed ? "" : "disabled"}>${t("run")}</button>`);
  if (["FAILED", "BLOCKED", "INTERRUPTED", "CHANGES_REQUESTED"].includes(ticket.status)) buttons.push(`<button data-ticket-action="retry" data-ticket="${esc(ticket.id)}" ${allowed ? "" : "disabled"}>${t("retry")}</button>`);
  if (attempt?.status === "AWAITING_CONFIRMATION") buttons.push(`<button data-ticket-action="confirm" data-attempt="${esc(attempt.id)}" data-ticket="${esc(ticket.id)}" class="primary">${t("confirm")}</button>`);
  if (!["DONE", "CANCELLED"].includes(ticket.status)) buttons.push(`<button data-ticket-action="cancel" data-ticket="${esc(ticket.id)}">${t("cancel")}</button>`);
  const preparation = ticket.preparation;
  const verification = ticket.verification;
  return `<article class="card"><div class="row"><h3>${esc(ticket.title)}</h3><span class="status ${esc(ticket.status)}">${esc(label("status", ticket.status))}</span></div><p>${esc(ticket.description)}</p><small class="muted">${esc(ticket.id)}${ticket.branch ? ` · ${esc(ticket.branch)}` : ""}</small>${preparation ? `<p><small>${t("preparation")}: <span class="status ${esc(preparation.status)}">${esc(label("status", preparation.status))}</span> · ${esc(preparation.strategy)}</small></p>` : ""}${preparation?.diagnosticDetail ? `<p class="error">${esc(preparation.diagnosticCode)} · ${esc(preparation.diagnosticDetail)}</p>` : ""}${preparation?.output ? `<details><summary>${t("preparationOutput")}</summary><pre>${esc(preparation.output.slice(0, 2_000))}</pre></details>` : ""}${verification ? `<p><small>${t("verification")}: <span class="status ${esc(verification.status)}">${esc(label("status", verification.status))}</span> · ${esc(verification.strategy)}</small></p>` : ""}${verification?.diagnosticDetail ? `<p class="error">${esc(verification.diagnosticCode)} · ${esc(verification.diagnosticDetail)}</p>` : ""}${verification?.output ? `<details><summary>${t("verificationOutput")}</summary><pre>${esc(verification.output.slice(0, 2_000))}</pre></details>` : ""}${ticket.review ? `<p><small>${t("review")}: ${esc(label("status", ticket.review.verdict))} — ${esc(ticket.review.summary)}</small></p>` : ""}${attempt?.diagnosticCode ? `<p class="error">${esc(attempt.diagnosticCode)} · ${esc(attempt.diagnosticDetail)}</p>` : ""}<div class="actions">${buttons.join("")}</div></article>`;
}

function renderAutoPanel() {
  const snapshot = state.auto || { enabled: false, run: null, events: [], queue: [] };
  const run = snapshot.run;
  const active = run && ["RUNNING", "PAUSED"].includes(run.status);
  const eligible = eligibility();
  const queue = (snapshot.queue || []).map((ticket) => ticket.id);
  const current = run?.currentTicketId ? state.tickets.find((ticket) => ticket.id === run.currentTicketId) : null;
  const needsWorkspaceApproval = run?.status === "PAUSED"
    && ["preparation.approval_required", "preparation.plan_changed", "verification.approval_required", "verification.plan_changed"].includes(run.reasonCode);
  const controls = run?.status === "RUNNING"
    ? `<button data-auto-action="pause">${t("pauseAuto")}</button><button data-auto-action="stop">${t("stopAuto")}</button>`
    : run?.status === "PAUSED"
      ? `${needsWorkspaceApproval ? `<button data-auto-approve class="primary">${t("approveAndResumeAuto")}</button>` : `<button data-auto-action="resume" class="primary" ${eligible.allowed ? "" : "disabled"}>${t("resumeAuto")}</button>`}<button data-auto-action="stop">${t("stopAuto")}</button>`
      : `<button data-auto-action="start" class="primary" ${eligible.allowed ? "" : "disabled"}>${t("startAuto")}</button>`;
  const recent = (snapshot.events || []).slice(-6).reverse();
  return `<article class="card auto-panel">
    <div class="row"><div><p class="kicker">${t("autoMode")}</p><h2>${active ? esc(label("status", run.status)) : t("manualDefault")}</h2></div><span class="status ${esc(run?.status || "MANUAL")}">${esc(label("status", run?.status || "MANUAL"))}</span></div>
    <p>${t("autoDescription")}</p>
    ${run?.reasonCode ? `<div class="auto-reason"><strong>${esc(run.reasonCode)}</strong><p>${esc(run.reasonDetail || "")}</p></div>` : ""}
    <div class="auto-grid"><div><small>${t("currentTicket")}</small><strong>${esc(current?.title || run?.currentTicketId || t("none"))}</strong></div><div><small>${t("plannedQueue")}</small><strong>${queue.length ? queue.map(esc).join(" → ") : t("emptyQueue")}</strong></div></div>
    <div class="actions">${controls}</div>
    ${recent.length ? `<details><summary>${t("recentAutoEvents")}</summary><div class="event-list">${recent.map((event) => `<small><span>${esc(label("autoEvent", event.type))}</span>${esc(event.ticketId || event.reasonCode || "")}</small>`).join("")}</div></details>` : ""}
  </article>`;
}

function renderOverview() {
  const counts = Object.fromEntries(state.tickets.map((ticket) => ticket.status).map((status) => [status, state.tickets.filter((ticket) => ticket.status === status).length]));
  const ready = eligibility();
  const next = nextAction(state);
  content.className = "stack";
  content.innerHTML = `
    <article class="next-action card"><div><p class="kicker">${t("nextAction")}</p><h2>${esc(next.label)}</h2></div><button class="primary" data-go-tab="${esc(next.tab)}">${t("go")}</button></article>
    ${renderAutoPanel()}
    <div class="grid">
      <article class="card"><h3>${t("repository")}</h3><p>${esc(state.inspection.branch || t("unbornBranch"))} · ${state.inspection.head ? esc(state.inspection.head.slice(0, 10)) : t("noBaseline")} · ${t(state.inspection.dirty ? "dirty" : "clean")}</p></article>
      <article class="card"><h3>${t("tickets")}</h3><p>${t("ticketCounts", { total: state.tickets.length, done: counts.DONE || 0, ready: counts.READY || 0 })}</p></article>
      <article class="card"><h3>${t("execution")}</h3><p>${ready.allowed ? t("eligibleAgentRuns") : esc(ready.reason)}</p></article>
    </div>
    <div class="split"><section><h2>${t("frontier")}</h2><div class="grid">${state.tickets.filter((ticket) => ["READY", "RUNNING", "REVIEW", "CHANGES_REQUESTED", "READY_TO_MERGE", "BLOCKED"].includes(ticket.status)).map(ticketCard).join("") || `<div class="empty">${t("noActiveTickets")}</div>`}</div></section>
    <section class="card"><div class="row"><h3>${t("preview")}</h3><div class="actions"><button data-preview="start">${t("start")}</button><button data-preview="stop">${t("stop")}</button></div></div><div id="preview">${t("loading")}</div></section></div>`;
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
    <div id="planning-banner" class="planning-banner ${planning.providerAvailable ? "ready" : "offline"}">
      <strong>${planning.providerAvailable ? esc(t("providerReady", { provider: state.capabilities?.provider || "Agent" })) : t("providerTitle")}</strong>
      <span>${t(state.inspection?.hasBaseCommit ? "planningManualAvailable" : "planningNoBaseline")}</span>
    </div>
    <div class="planning-layout">
      <section class="card conversation-panel" id="planning-conversation" tabindex="-1">
        <div class="row"><div><p class="kicker">${t("conversation")}</p><h2>${t("shapeWorkTogether")}</h2></div><span id="planning-thread-status" class="status ${esc(planning.thread?.status || "idle")}">${esc(label("status", planning.thread?.status || "idle"))}</span></div>
        <div id="planning-transcript" class="transcript" tabindex="0" role="log" aria-live="polite" aria-relevant="additions text">${planningTranscript(planning.messages)}</div>
        <button id="planning-new-messages" class="new-messages hidden" type="button"></button>
        <form id="planning-composer" class="composer"><textarea id="planning-message" placeholder="${t("messagePlaceholder")}" aria-label="${t("messagePlaceholder")}" ${providerDisabled}></textarea><button id="send-planning-message" type="submit" class="primary" ${providerDisabled}>${t("send")}</button></form>
      </section>
      <aside class="card operation-panel" id="planning-operation">
        <p class="kicker">${t("durableOperation")}</p>
        ${active ? planningOperation(active, planning.events) : `<p class="muted">${t("noGeneration")}</p>`}
        ${failed.map(planningErrorCard).join("")}
        ${interrupted.map((session) => `<div class="interrupted"><strong>${esc(label("stage", session.stage))} · ${t("statusInterrupted")}</strong><small>${esc(session.errorDetail || t("previousRuntimeStopped"))}</small><button data-planning-resume="${esc(session.id)}" ${providerDisabled}>${t("resume")}</button></div>`).join("")}
        ${!planning.providerAvailable ? `<p class="warning">${t("generationNeedsProvider")}</p>` : ""}
      </aside>
    </div>
    <div class="planning-actions">
      <button id="generate-spec" class="primary" ${providerDisabled || active ? "disabled" : ""}>${t("generateSpec")}</button>
      <button id="generate-tickets" ${providerDisabled || active || approvedSpecs.length === 0 ? "disabled" : ""}>${t("generateTickets")}</button>
    </div>
    <section id="planning-artifacts" data-artifact-signature="${esc(planningArtifactSignature(artifacts))}" tabindex="-1"><div class="row"><div><p class="kicker">${t("revisions")}</p><h2>${t("reviewBeforeExecution")}</h2></div><small class="muted">${t("approveThenConfirm")}</small></div>
      <div class="artifact-list">${artifacts.map(planningArtifact).join("") || `<div class="empty">${t("noPlanningArtifacts")}</div>`}</div>
    </section>
    <div class="planning-layout editors">
      <section class="card"><p class="kicker">${t("structuredSpecEditor")}</p><h3>${latestSpec ? t("editSpecVersion", { version: latestSpec.revision }) : t("newSpecRevision")}</h3>
        <label>${t("approvedConversationSnapshot")}<select id="spec-predecessor">${approvedInterrogations.map((artifact) => `<option value="${esc(artifact.id)}" ${artifact.id === latestSpec?.predecessorArtifactId ? "selected" : ""}>${t("conversationVersion", { version: artifact.revision })}</option>`).join("")}</select></label>
        <label>${t("title")}<input id="spec-title" value="${esc(latestSpec?.content?.title || "")}" placeholder="${t("specificationTitle")}"></label>
        <label>${t("summary")}<textarea id="spec-summary" placeholder="${t("shortOverview")}">${esc(latestSpec?.content?.summary || "")}</textarea></label>
        ${specListField("goals", "spec-goals", latestSpec?.content?.goals)}
        ${specListField("nonGoals", "spec-non-goals", latestSpec?.content?.nonGoals)}
        ${specListField("requirements", "spec-requirements", latestSpec?.content?.requirements)}
        ${specListField("acceptanceCriteria", "spec-acceptance", latestSpec?.content?.acceptanceCriteria)}
        ${specListField("constraints", "spec-constraints", latestSpec?.content?.constraints)}
        <button id="save-spec" class="primary" ${approvedInterrogations.length === 0 ? "disabled" : ""}>${t("saveNewRevision")}</button>
      </section>
      <section class="card"><p class="kicker">${t("ticketDagEditor")}</p><div class="row"><h3>${latestTickets ? t("editTicketPlanVersion", { version: latestTickets.revision }) : t("newTicketPlan")}</h3><button id="add-plan-ticket">${t("addRow")}</button></div>
        <label>${t("approvedSpec")}<select id="ticket-spec">${approvedSpecs.map((artifact) => `<option value="${esc(artifact.id)}" ${artifact.id === latestTickets?.predecessorArtifactId ? "selected" : ""}>SPEC v${artifact.revision} · ${esc(artifact.content?.title)}</option>`).join("")}</select></label>
        <div id="ticket-plan-rows" class="ticket-plan-rows">${(latestTickets?.content?.tickets || [{ id: "", title: "", description: "", predecessorIds: [] }]).map(ticketPlanRow).join("")}</div>
        <button id="save-ticket-plan" class="primary" ${approvedSpecs.length === 0 ? "disabled" : ""}>${t("validateSaveRevision")}</button>
      </section>
    </div>`;
  transcriptPinned = true;
  requestAnimationFrame(() => scrollTranscriptToEnd(false));
}

function visiblePlanningMessages(messages = []) {
  return messages.filter((message) => message.role !== "system");
}

function planningArtifactSignature(artifacts = []) {
  return artifacts.map((artifact) => `${artifact.id}:${artifact.status}:${artifact.confirmedAt || ""}`).join("|");
}

function planningTranscript(messages) {
  const visible = visiblePlanningMessages(messages);
  return visible.map((message, index) => `
    <div class="message ${esc(message.role)}" data-message-id="${esc(message.id || `${message.createdAt}-${index}`)}"><small>${esc(label("role", message.role))} · ${formatDate(message.createdAt)}</small><p>${esc(message.content)}</p></div>`).join("") || `<div class="empty compact">${t("conversationEmpty")}</div>`;
}

function planningOperationContent(planning) {
  const active = planning.sessions.find((session) => ["idle", "running"].includes(session.status));
  const interrupted = planning.sessions.filter((session) => session.status === "interrupted");
  const failed = planning.sessions.filter((session) => session.status === "error" && !planning.sessions.some((candidate) => candidate.retryOfSessionId === session.id));
  const providerDisabled = planning.providerAvailable ? "" : "disabled";
  return `<p class="kicker">${t("durableOperation")}</p>
    ${active ? planningOperation(active, planning.events) : `<p class="muted">${t("noGeneration")}</p>`}
    ${failed.map(planningErrorCard).join("")}
    ${interrupted.map((session) => `<div class="interrupted"><strong>${esc(label("stage", session.stage))} · ${t("statusInterrupted")}</strong><small>${esc(session.errorDetail || t("previousRuntimeStopped"))}</small><button data-planning-resume="${esc(session.id)}" ${providerDisabled}>${t("resume")}</button></div>`).join("")}
    ${!planning.providerAvailable ? `<p class="warning">${t("generationNeedsProvider")}</p>` : ""}`;
}

function updatePlanningLive() {
  const planning = state.planning;
  const transcript = $("#planning-transcript");
  const operation = $("#planning-operation");
  if (!planning || !transcript || !operation) return;
  const artifactContainer = $("#planning-artifacts");
  const artifactChanged = artifactContainer?.dataset.artifactSignature !== planningArtifactSignature(planning.artifacts);
  const editingArtifact = document.activeElement?.closest?.(".editors");
  if (artifactChanged && !editingArtifact && document.activeElement?.id !== "planning-message") {
    renderPlanning();
    return;
  }
  const visible = visiblePlanningMessages(planning.messages);
  const previousTop = transcript.scrollTop;
  const wasPinned = transcriptPinned || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
  const previousCount = transcript.querySelectorAll("[data-message-id]").length;
  transcript.innerHTML = planningTranscript(planning.messages);
  operation.innerHTML = planningOperationContent(planning);
  const status = $("#planning-thread-status");
  if (status) {
    status.className = `status ${planning.thread?.status || "idle"}`;
    status.textContent = label("status", planning.thread?.status || "idle");
  }
  if (wasPinned) {
    scrollTranscriptToEnd(false);
    transcriptUnread = 0;
  } else {
    transcript.scrollTop = previousTop;
    transcriptUnread += Math.max(0, visible.length - previousCount);
  }
  updateNewMessagesButton();
}

function scrollTranscriptToEnd(smooth = true) {
  const transcript = $("#planning-transcript");
  if (!transcript) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  transcript.scrollTo({ top: transcript.scrollHeight, behavior: smooth && !reduced ? "smooth" : "auto" });
  transcriptPinned = true;
  transcriptUnread = 0;
  updateNewMessagesButton();
}

function updateNewMessagesButton() {
  const button = $("#planning-new-messages");
  if (!button) return;
  button.classList.toggle("hidden", transcriptUnread === 0);
  button.textContent = transcriptUnread ? `${plural("newMessages", transcriptUnread)} · ${t("jumpToLatest")}` : "";
}

async function submitPlanningMessage() {
  const textarea = $("#planning-message");
  const button = $("#send-planning-message");
  const contentValue = textarea?.value.trim() || "";
  if (!textarea || !contentValue || planningMessagePending) return;
  planningMessagePending = true;
  textarea.disabled = true;
  button.disabled = true;
  try {
    await json(`${base()}/planning/messages`, mutation({ content: contentValue }));
    textarea.value = "";
    transcriptPinned = true;
    await refreshPlanningSnapshot();
    scrollTranscriptToEnd();
  } finally {
    planningMessagePending = false;
    textarea.disabled = !state.planning?.providerAvailable;
    button.disabled = !state.planning?.providerAvailable;
    textarea.focus();
  }
}

async function refreshPlanningSnapshot() {
  const [planning, activity] = await Promise.all([json(`${base()}/planning`), json(`${base()}/activity`)]);
  state.planning = planning;
  state.activity = activity;
  const entry = state.projects.find((candidate) => candidate.project.id === state.project.id);
  if (entry) entry.attention = activity.summary;
  renderProjects();
  updatePlanningLive();
  renderProgress();
}

function planningErrorCard(session) {
  const diagnostic = diagnosticFor(session.errorCode);
  const canRetry = state.planning?.providerAvailable;
  return `<article class="diagnostic error-severity" data-session-error="${esc(session.id)}">
    <div class="row"><div><p class="kicker">${esc(label("stage", session.stage))} · ${formatDate(session.completedAt || session.updatedAt)}</p><h3>${esc(diagnostic.title)}</h3></div><span class="status error">${esc(label("status", "error"))}</span></div>
    <p>${esc(diagnostic.body)}</p>
    <div class="actions">
      ${diagnostic.action === "retry" || diagnostic.action === null ? `<button class="primary" data-planning-retry="${esc(session.id)}" ${canRetry ? "" : "disabled"}>${t("retry")}</button>` : ""}
      ${diagnostic.action === "auth_help" ? `<a class="button" href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noreferrer">${t("authHelp")}</a>` : ""}
      ${diagnostic.action === "open_settings" ? `<button data-go-tab="settings">${t("openSettings")}</button>` : ""}
      <button data-copy-session="${esc(session.id)}">${t("copyDiagnostic")}</button>
    </div>
    <details><summary>${t("technicalDetails")}</summary><pre>${esc(`${session.errorCode || "planning.error"}\n${session.errorDetail || t("noDetail")}`)}</pre></details>
  </article>`;
}

function planningOperation(session, events) {
  const sessionEvents = events.filter((event) => event.sessionId === session.id);
  return `<div class="operation-progress"><div class="row"><strong>${esc(label("stage", session.stage))}</strong><span class="status ${esc(session.status)}">${esc(label("status", session.status))}</span></div>
    <div class="event-list">${compactEvents(sessionEvents.slice(-12)).slice(-6).map(renderPlanningEvent).join("") || `<small>${t("queuedDurably")}</small>`}</div>
    <button data-planning-cancel="${esc(session.id)}">${t("cancel")}</button></div>`;
}

function eventSummary(payload) {
  if (!payload) return "";
  if (payload.type === "assistant_message") return payload.text?.slice(0, 160) || "";
  if (payload.type === "error" || payload.type === "warning") return [payload.code, payload.message].filter(Boolean).join(" · ");
  if (payload.type === "completed") return payload.summary || t(payload.success ? "operationCompleted" : "operationFailed");
  if (payload.type === "tool_call") return payload.name || payload.callId || "";
  if (payload.type === "tool_result") return `${payload.success ? "✓" : "×"} ${payload.output?.slice(0, 140) || payload.callId || ""}`;
  if (payload.type === "file_change") return payload.summary || plural("filesChanged", payload.paths?.length || 0);
  if (payload.type === "command") return `${payload.command || ""}${payload.cwd ? ` · ${payload.cwd}` : ""}${payload.exitCode !== undefined ? ` · ${t("commandExit", { code: payload.exitCode })}` : ` · ${t("commandRunning")}`}`;
  if (payload.type === "usage") return t("tokensUsed", { input: payload.inputTokens, output: payload.outputTokens });
  if (payload.type === "review_decision") return `${t(payload.verdict === "approved" ? "reviewApproved" : "reviewChanges")} · ${payload.summary || ""}`;
  return "";
}

function renderPlanningEvent(event) {
  const payload = event.payload || {};
  const type = payload.type || event.type;
  const detail = payload.type === "command" && payload.output
    ? `<details><summary>${t("technicalDetails")}</summary><pre>${esc(payload.output)}</pre></details>`
    : "";
  return `<small class="event-row"><span>${esc(label("event", type))}</span><code>${esc(eventSummary(payload))}</code>${event.count > 1 ? `<b>×${event.count}</b>` : ""}${detail}</small>`;
}

function compactEvents(events) {
  const compacted = [];
  for (const event of events) {
    const signature = JSON.stringify([event.type, event.payload]);
    const previous = compacted.at(-1);
    if (previous?.signature === signature) previous.count += 1;
    else compacted.push({ ...event, signature, count: 1 });
  }
  return compacted;
}

function artifactBadges(artifact) {
  return `<span class="badge ${esc(artifact.status)}">${esc(label("status", artifact.status))}</span>${artifact.confirmedAt ? `<span class="badge confirmed">${t("confirmed")}</span>` : ""}`;
}

function planningArtifact(artifact) {
  const predecessor = artifact.predecessorArtifactId ? ` · ${t("fromArtifact", { id: esc(artifact.predecessorArtifactId.slice(0, 8)) })}` : "";
  let body = "";
  if (artifact.kind === "interrogation") {
    const messages = artifact.content?.messages;
    body = `<p>${esc(Array.isArray(messages) ? plural("approvedMessages", messages.length) : artifact.content?.markdown || t("conversationSnapshot"))}</p>`;
  } else if (artifact.kind === "spec") {
    body = `<h4>${esc(artifact.content?.title)}</h4><p>${esc(artifact.content?.summary)}</p><small>${t("artifactRequirements", { requirements: artifact.content?.requirements?.length || 0, criteria: artifact.content?.acceptanceCriteria?.length || 0 })}</small>`;
  } else {
    body = `<div class="mini-ticket-list">${(artifact.content?.tickets || []).map((ticket) => `<span><strong>${esc(ticket.id)}</strong> ${esc(ticket.title)}${ticket.predecessorIds.length ? ` ← ${ticket.predecessorIds.map(esc).join(", ")}` : ""}</span>`).join("")}</div>`;
  }
  return `<article class="card artifact-card"><div class="row"><div><h3>${esc(label("artifact", artifact.kind))} v${artifact.revision}</h3><small class="muted">${esc(label("role", artifact.authorRole))}${predecessor}</small></div><div class="badges">${artifactBadges(artifact)}</div></div>${body}<div class="actions">${artifact.status === "draft" ? `<button data-artifact-approve="${esc(artifact.id)}">${t("approveRevision")}</button>` : ""}${artifact.kind === "tickets" && artifact.status === "approved" ? `<button class="primary" data-confirm-plan="${esc(artifact.id)}">${artifact.confirmedAt ? t("dagConfirmed") : t("confirmDag")}</button>` : ""}</div></article>`;
}

function specListField(key, id, values) {
  return `<label>${t(key)} <small>${t("onePerLine")}</small><textarea id="${id}">${esc((values || []).join("\n"))}</textarea></label>`;
}

function ticketPlanRow(ticket) {
  return `<div class="ticket-plan-row">
    <div class="row"><strong>${t("ticket")}</strong><button data-remove-plan-ticket title="${t("removeRow")}">${t("remove")}</button></div>
    <label>${t("id")}<input data-plan-id value="${esc(ticket.id)}" placeholder="stable-ticket-id"></label>
    <label>${t("title")}<input data-plan-title value="${esc(ticket.title)}" placeholder="${t("verticalSlice")}"></label>
    <label>${t("description")}<textarea data-plan-description placeholder="${t("endToEndOutcome")}">${esc(ticket.description)}</textarea></label>
    <label>${t("predecessorIds")} <small>${t("commaSeparated")}</small><input data-plan-predecessors value="${esc((ticket.predecessorIds || []).join(", "))}" placeholder="ticket-a, ticket-b"></label>
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
    <div class="row"><strong>${t("preparationUnit")}</strong><div class="actions"><button data-preparation-up title="${t("moveUp")}">↑</button><button data-preparation-down title="${t("moveDown")}">↓</button><button data-remove-preparation title="${t("remove")}">${t("remove")}</button></div></div>
    <label>${t("repositoryRelativeRoot")}<input data-preparation-root value="${esc(unit.root || ".")}" placeholder="packages/api"></label>
    <label>${t("strategy")}<select data-preparation-strategy>${preparationStrategies.map((strategy) => `<option value="${strategy}" ${strategy === unit.strategy ? "selected" : ""}>${strategy}</option>`).join("")}</select></label>
    <label data-preparation-shell class="${shell ? "" : "hidden"}">${t("trackedScript")}<input data-preparation-script value="${esc(unit.script || "")}" placeholder="scripts/prepare.sh"></label>
    <label data-preparation-shell class="${shell ? "" : "hidden"}">${t("literalArguments")} <small>${t("noShellInterpolation")}</small><textarea data-preparation-args>${esc((unit.args || []).join("\n"))}</textarea></label>
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
  if (!plan?.applicable) return `<p class="muted">${t("noPreparationApplies")}</p>`;
  return `<div class="ticket-plan-rows">${plan.units.map((unit) => `<article class="target"><span><strong>${esc(unit.strategy)} · ${esc(unit.root)}</strong><small>${unit.commands.map((command) => esc(command.display)).join("<br>")}</small><small>${esc(unit.executablePath || t("toolUnavailable"))} · ${esc(unit.toolVersion)}</small></span></article>`).join("")}</div><small class="muted">${t("fingerprint", { fingerprint: esc(plan.fingerprint) })}</small>`;
}

function verificationUnitRow(unit = { root: ".", strategy: "pnpm" }) {
  const shell = ["bash", "pwsh"].includes(unit.strategy);
  return `<div class="ticket-plan-row" data-verification-unit>
    <div class="row"><strong>${t("verificationUnit")}</strong><div class="actions"><button data-verification-up title="${t("moveUp")}">↑</button><button data-verification-down title="${t("moveDown")}">↓</button><button data-remove-verification title="${t("remove")}">${t("remove")}</button></div></div>
    <label>${t("repositoryRelativeRoot")}<input data-verification-root value="${esc(unit.root || ".")}" placeholder="packages/api"></label>
    <label>${t("strategy")}<select data-verification-strategy>${preparationStrategies.map((strategy) => `<option value="${strategy}" ${strategy === unit.strategy ? "selected" : ""}>${strategy}</option>`).join("")}</select></label>
    <label data-verification-shell class="${shell ? "" : "hidden"}">${t("trackedScript")}<input data-verification-script value="${esc(unit.script || "")}" placeholder="scripts/verify.sh"></label>
    <label data-verification-shell class="${shell ? "" : "hidden"}">${t("literalArguments")} <small>${t("noShellInterpolation")}</small><textarea data-verification-args>${esc((unit.args || []).join("\n"))}</textarea></label>
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
  if (!plan?.applicable) return `<p class="error">${t("noVerificationConvention")}</p>`;
  return `<div class="ticket-plan-rows">${plan.units.map((unit) => `<article class="target"><span><strong>${esc(unit.strategy)} · ${esc(unit.root)}</strong><small>${unit.commands.map((command) => esc(command.display)).join("<br>")}</small><small>${esc(unit.executablePath || t("toolUnavailable"))} · ${esc(unit.toolVersion)}</small></span></article>`).join("")}</div><small class="muted">${t("fingerprint", { fingerprint: esc(plan.fingerprint) })}</small>`;
}

function renderTickets() {
  content.className = "stack";
  content.innerHTML = `<div id="execution-section" tabindex="-1">${renderAutoPanel()}</div><div class="grid">${state.tickets.map(ticketCard).join("") || `<div class="empty">${t("noTickets")}</div>`}</div><article class="card"><h3>${t("createTicket")}</h3><input id="ticket-title" placeholder="${t("title")}"><textarea id="ticket-description" placeholder="${t("ticketDescriptionPlaceholder")}"></textarea><input id="ticket-predecessors" placeholder="${t("predecessorPlaceholder")}"><button id="create-ticket" class="primary">${t("create")}</button></article>`;
}

function renderDag() {
  content.className = "stack";
  content.innerHTML = `<p class="muted">${t("dagReadOnly")}</p><div class="dag">${state.tickets.map((ticket) => { const blockers = state.dependencies.filter((edge) => edge.ticketId === ticket.id).map((edge) => edge.predecessorId); return `<article class="card node"><div class="row"><strong>${esc(ticket.title)}</strong><span class="status ${esc(ticket.status)}">${esc(label("status", ticket.status))}</span></div><p class="edge">${t("blockedBy", { ids: blockers.map(esc).join(", ") || t("noBlockers") })}</p></article>`; }).join("")}</div>`;
}

function renderActivity() {
  content.className = "stack";
  const items = state.activity?.items ?? [];
  content.innerHTML = `<section><div class="row"><div><p class="kicker">${t("activity")}</p><h2>${state.activity?.summary?.count ?? 0} ${t("attention")}</h2></div></div>
    <div class="activity-list">${items.map((item) => {
      const diagnostic = diagnosticFor(item.code);
      const title = item.severity === "info" ? activityTitle(item) : diagnostic.title;
      return `<article class="activity-item ${esc(item.severity)} ${item.resolved ? "resolved" : ""}">
        <span class="activity-marker" aria-hidden="true"></span><div><div class="row"><strong>${esc(title)}</strong><time datetime="${esc(item.occurredAt)}">${formatDate(item.occurredAt)}</time></div>
        <p>${esc(item.severity === "info" ? item.detail || item.status : diagnostic.body)}</p>
        <small>${esc(label("source", item.source))} · ${esc(label(item.source === "auto" ? "autoEvent" : "status", item.status))}${item.code ? ` · ${esc(item.code)}` : ""}${item.resolved ? ` · ${t("resolved")}` : ""}</small>
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
  if (item.action === "open_auto") return `<button data-go-tab="tickets">${t("openTicket")}</button>`;
  if (item.action === "open_settings" || item.action === "approve_preparation") return `<button data-go-tab="settings">${t("openSettings")}</button>`;
  if (item.action === "confirm_integration" && item.ticketId) return `<button data-open-ticket="${esc(item.ticketId)}">${t("openTicket")}</button>`;
  return "";
}

function renderProgress() {
  const artifacts = state.planning?.artifacts ?? [];
  const hasAttention = (state.activity?.summary?.count ?? 0) > 0;
  const allDone = state.tickets.length > 0 && state.tickets.every((ticket) => ticket.status === "DONE");
  const hasConfirmedPlan = artifacts.some((item) => item.kind === "tickets" && item.confirmedAt);
  const steps = [
    { key: "ideaPlan", description: "progressIdeaDescription", tab: "planning", target: "planning-conversation", active: state.tab === "planning", done: hasConfirmedPlan },
    { key: "tickets", description: "progressTicketsDescription", tab: hasConfirmedPlan ? "tickets" : "planning", target: hasConfirmedPlan ? null : "planning-artifacts", active: ["tickets", "dag"].includes(state.tab), done: state.tickets.length > 0 },
    { key: "execution", description: "progressExecutionDescription", tab: "tickets", target: "execution-section", active: state.tab === "tickets", done: allDone },
    { key: "integration", description: "progressIntegrationDescription", tab: "activity", target: null, active: state.tab === "activity", done: allDone, attention: hasAttention },
  ];
  $("#progress").innerHTML = steps.map((step, index) => {
    const status = t(step.attention ? "progressAttention" : step.active ? "progressActive" : step.done ? "progressDone" : "progressPending");
    const aria = t("progressLabel", { step: index + 1, name: t(step.key), status, description: t(step.description) });
    return `<button class="progress-step ${step.done ? "done" : ""} ${step.active ? "active" : ""} ${step.attention ? "attention" : ""}" data-progress-tab="${step.tab}" ${step.target ? `data-progress-target="${step.target}"` : ""} aria-label="${esc(aria)}" title="${esc(t(step.description))}" ${step.active ? 'aria-current="step"' : ""}><i aria-hidden="true">${step.done ? "✓" : index + 1}</i><span>${t(step.key)}</span><small>${esc(status)}</small></button>`;
  }).join("");
}

function activityTitle(item) {
  if (item.source === "ticket") return item.title;
  if (item.source === "planning") return t("planningStage", { stage: label("stage", item.title.replace(/^Planning\s+/u, "")) });
  if (item.source === "preparation") return t("workspacePreparation");
  if (item.source === "verification") return t("workspaceVerification");
  if (item.source === "integration") return t("integration");
  if (item.source === "auto") return t("autoExecution");
  return item.title;
}

async function renderHistory() {
  content.className = "stack";
  content.innerHTML = `<div class="empty">${t("loadingHistory")}</div>`;
  const rows = await Promise.all(state.tickets.map(async (ticket) => ({
    ticket,
    data: await json(`${base()}/tickets/${encodeURIComponent(ticket.id)}/history`),
    preparation: await json(`${base()}/tickets/${encodeURIComponent(ticket.id)}/preparation`),
    verification: await json(`${base()}/tickets/${encodeURIComponent(ticket.id)}/verification`),
  })));
  content.innerHTML = rows.map(({ ticket, data, preparation, verification }) => `<article class="card"><h3>${esc(ticket.title)}</h3><pre>${esc(data.history.map((entry) => `${entry.createdAt}  ${entry.fromStatus || "∅"} → ${entry.toStatus}  ${entry.reason}`).join("\n"))}</pre>${preparation.attempts.length ? `<h4>${t("workspacePreparation")}</h4><pre>${esc(JSON.stringify(preparation.attempts, null, 2))}</pre>` : ""}${verification.attempts.length ? `<h4>${t("workspaceVerification")}</h4><pre>${esc(JSON.stringify(verification.attempts, null, 2))}</pre>` : ""}</article>`).join("") || `<div class="empty">${t("noHistory")}</div>`;
}

async function renderSessions() {
  content.className = "stack";
  content.innerHTML = `<div class="empty">${t("loadingSessions")}</div>`;
  const rows = await Promise.all(state.tickets.map(async (ticket) => ({ ticket, data: await json(`${base()}/tickets/${encodeURIComponent(ticket.id)}/sessions`) })));
  content.innerHTML = rows.map(({ ticket, data }) => `<article class="card"><h3>${esc(ticket.title)}</h3><pre>${esc(JSON.stringify(data.sessions, null, 2))}</pre></article>`).join("") || `<div class="empty">${t("noSessions")}</div>`;
}

async function renderSettings() {
  content.className = "stack";
  content.innerHTML = `<div class="empty">${t("loadingSettings")}</div>`;
  const [settings, preparation, verification] = await Promise.all([json(`${base()}/settings`), json(`${base()}/preparation`), json(`${base()}/verification`)]);
  const units = preparation.config.mode === "explicit" ? preparation.config.units || [] : [];
  const verificationUnits = verification.config.mode === "explicit" ? verification.config.units || [] : [];
  const effective = settings?.effective;
  content.innerHTML = `<article class="card"><div class="row"><div><p class="kicker">${t("agentPolicy")}</p><h3>${t("projectConfiguration")}</h3></div><small class="muted">${t("validatedOverride")}</small></div>
    <div class="settings-grid"><label>${t("integration")}<select id="settings-integration"><option value="auto" ${effective?.integrationMode === "auto" ? "selected" : ""}>${t("automaticAfterReview")}</option><option value="confirm" ${effective?.integrationMode === "confirm" ? "selected" : ""}>${t("alwaysConfirm")}</option></select></label>
    <label>${t("review")}<select id="settings-review"><option value="independent" ${effective?.reviewMode === "independent" ? "selected" : ""}>${t("independentSession")}</option><option value="self" ${effective?.reviewMode === "self" ? "selected" : ""}>${t("selfReview")}</option></select></label></div>
    <div class="stage-table">${Object.entries(effective?.stages || {}).map(([stage, value]) => stageSettingsRow(stage, value)).join("")}</div>
    <button id="save-settings" class="primary">${t("validateSave")}</button>
    <details><summary>${t("rawConfiguration")}</summary><pre>${esc(JSON.stringify(effective, null, 2))}</pre></details>
  </article><article class="card"><h3>${t("workspacePreparation")}</h3><p>${t("preparationDescription")}</p><label>${t("detectionMode")}<select id="preparation-mode"><option value="auto" ${preparation.config.mode === "auto" ? "selected" : ""}>${t("autoDetectRoot")}</option><option value="explicit" ${preparation.config.mode === "explicit" ? "selected" : ""}>${t("explicitUnits")}</option></select></label><div id="preparation-unit-editor" class="ticket-plan-rows ${preparation.config.mode === "explicit" ? "" : "hidden"}">${units.map(preparationUnitRow).join("")}</div><div class="actions"><button id="add-preparation-unit" class="${preparation.config.mode === "explicit" ? "" : "hidden"}">${t("addUnit")}</button><button id="save-preparation" class="primary">${t("savePreparation")}</button><button id="revoke-preparation" ${preparation.approval ? "" : "disabled"}>${t("revokeApproval")}</button></div>${renderDetectedPreparation(preparation)}</article>
  <article class="card"><h3>${t("workspaceVerification")}</h3><p>${t("verificationDescription")}</p><label>${t("detectionMode")}<select id="verification-mode"><option value="auto" ${verification.config.mode === "auto" ? "selected" : ""}>${t("autoDetectRoot")}</option><option value="explicit" ${verification.config.mode === "explicit" ? "selected" : ""}>${t("explicitUnits")}</option></select></label><div id="verification-unit-editor" class="ticket-plan-rows ${verification.config.mode === "explicit" ? "" : "hidden"}">${verificationUnits.map(verificationUnitRow).join("")}</div><div class="actions"><button id="add-verification-unit" class="${verification.config.mode === "explicit" ? "" : "hidden"}">${t("addUnit")}</button><button id="save-verification" class="primary">${t("saveVerification")}</button><button id="revoke-verification" ${verification.approval ? "" : "disabled"}>${t("revokeApproval")}</button></div>${renderDetectedVerification(verification)}</article>
  <article class="card"><h3>${t("safeCleanup")}</h3><p>${t("cleanupDescription")}</p><button id="plan-cleanup" class="danger-button">${t("buildCleanupPlan")}</button></article>`;
}

function stageSettingsRow(stage, selected) {
  const models = state.capabilities?.models ?? [];
  const model = models.find((item) => item.id === selected.model) ?? models[0];
  const efforts = model?.efforts ?? [];
  return `<fieldset data-settings-stage="${esc(stage)}"><legend>${esc(label("stage", stage))}</legend>
    <label>${t("provider")}<input data-stage-provider value="${esc(state.capabilities?.provider || selected.provider)}" readonly></label>
    <label>${t("model")}<select data-stage-model>${models.map((item) => `<option value="${esc(item.id)}" ${item.id === selected.model ? "selected" : ""}>${esc(item.id)}</option>`).join("")}</select></label>
    <label>${t("effort")}<select data-stage-effort><option value="">${t("notApplicable")}</option>${efforts.map((effort) => `<option value="${esc(effort)}" ${effort === selected.effort ? "selected" : ""}>${esc(effort)}</option>`).join("")}</select></label>
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
    ? t("approveCombinedTitle")
    : t(kind === "verification" ? "approveVerificationTitle" : "approvePreparationTitle");
  $("#workspace-approval-description").textContent = kind === "combined"
    ? t("approveCombinedBody")
    : kind === "verification"
      ? t("approveVerificationBody")
      : t("approvePreparationBody");
  const renderPlan = (labelText, current) => `<section class="stack"><strong>${esc(labelText)}</strong>${current.units.map((unit) => `<article class="target"><span><strong>${esc(unit.strategy)} · ${esc(unit.root)}</strong><small>${unit.commands.map((command) => esc(command.display)).join("<br>")}</small><small>${esc(unit.executablePath || t("toolUnavailable"))} · ${esc(unit.toolVersion)}</small></span></article>`).join("")}</section>`;
  $("#workspace-approval-commands").innerHTML = [
    sourceKind === "preparation" ? renderPlan(t("preparation"), plan) : "",
    sourceKind === "verification" ? renderPlan(t("verification"), plan) : "",
    includeVerification ? renderPlan(t("verification"), verificationPlan) : "",
  ].join("");
  $("#workspace-approval-fingerprint").textContent = [
    sourceKind === "preparation" ? t("preparationFingerprint", { fingerprint: plan.fingerprint }) : "",
    sourceKind === "verification" ? t("verificationFingerprint", { fingerprint: plan.fingerprint }) : "",
    includeVerification ? t("verificationFingerprint", { fingerprint: verificationPlan.fingerprint }) : "",
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

async function executeAutoAction(body) {
  return await json(`${base()}/auto/actions`, mutation(body));
}

async function showAutoWorkspaceApproval() {
  const run = state.auto?.run;
  if (!run?.currentTicketId) throw new Error(t("autoNoApprovalTicket"));
  const ticket = state.tickets.find((candidate) => candidate.id === run.currentTicketId);
  const sourceKind = run.reasonCode?.startsWith("verification.") ? "verification" : "preparation";
  const attempt = sourceKind === "verification" ? ticket?.verification : ticket?.preparation;
  if (!attempt?.plan) throw new Error(run.reasonDetail || t("workspacePlanUnavailable"));
  const error = Object.assign(new Error(run.reasonDetail || t("workspaceApprovalRequired")), {
    code: run.reasonCode,
    details: { plan: attempt.plan },
  });
  await showWorkspaceApproval(error, {
    auto: true,
    ticketId: run.currentTicketId,
    body: { action: "resume", runId: run.id },
  });
}

async function refreshPreview() {
  if (!state.project || !$("#preview")) return;
  const active = state.tickets.find((ticket) => ["RUNNING", "REVIEW", "CHANGES_REQUESTED", "READY_TO_MERGE"].includes(ticket.status));
  const status = await json(`${base()}/preview${active ? `?ticketId=${encodeURIComponent(active.id)}` : ""}`);
  if (!$("#preview")) return;
  $("#preview").innerHTML = status.url && status.running ? `<iframe class="preview-frame" src="${esc(status.url)}"></iframe>` : `<pre>${esc(status.diagnostic || status.logs || `${t("source")}: ${status.source}\n${status.root}`)}</pre>`;
}

async function action(operation, refresh = true) {
  pendingActions += 1;
  document.body.setAttribute("aria-busy", "true");
  clearNotice();
  try {
    await operation();
    if (refresh && state.project) await refreshProject();
  } catch (error) {
    showNotice(error);
  } finally {
    pendingActions -= 1;
    if (pendingActions === 0) document.body.removeAttribute("aria-busy");
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
  $("#inspection").textContent = t(mode === "create" ? "chooseCreateDirectory" : "chooseExistingDirectory");
  $("#save-project").disabled = true;
  $("#project-dialog").showModal();
  if (path) void inspectWizard();
}

async function inspectWizard() {
  const path = $("#new-project-path").value.trim();
  if (!path) throw new Error(t("enterFolderFirst"));
  const inspection = await json("/api/projects/inspect", mutation({ path }));
  state.wizardInspection = inspection;
  const operation = operationFor(inspection);
  $("#inspection").className = `inspection operation ${operation ? "" : "warn"}`;
  $("#inspection").innerHTML = `<strong>${esc(label("kind", inspection.kind))}</strong><p>${esc(operation?.description || inspection.diagnostics.map((item) => item.message).join(" ") || t("pathCannotBeUsed"))}</p>${inspection.canonicalPath ? `<small>${esc(inspection.canonicalPath)}</small>` : ""}`;
  $("#save-project").disabled = !operation;
  $("#save-project").textContent = operation?.label || t("unavailable");
}

function operationFor(inspection) {
  if (inspection.kind === "git_repository" && inspection.canRegister) return { action: "register", label: t("openRepository"), description: t("registerRepository") };
  if ((inspection.kind === "missing" || inspection.kind === "empty_directory") && inspection.canCreate) return { action: "create", label: t("createProject"), description: t("createProjectDescription") };
  if (inspection.kind === "non_git_directory" && inspection.canInitialize) return { action: "initialize", label: t("initializeGit"), description: t("initializeGitDescription") };
  return null;
}

async function confirmWizard() {
  const inspection = state.wizardInspection;
  const operation = inspection && operationFor(inspection);
  if (!inspection || !operation) throw new Error(t("inspectSupportedPath"));
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
  $("#cleanup-targets").innerHTML = plan.targets.map((target) => `<label class="target"><input type="checkbox" data-cleanup-target="${esc(target.id)}" ${target.selectedByDefault ? "checked" : ""}><span><strong>${esc(cleanupTargetLabel(target))}</strong><small>${esc(target.path || target.branch || target.kind)}${target.requiresForce ? ` · ${t("forceRequired")}` : ""}</small></span></label>`).join("");
  $("#cleanup-warnings").textContent = plan.warnings.map((warning) => warning.message).join("\n");
  $("#cleanup-phrase").value = "";
  $("#cleanup-force").checked = false;
  $("#cleanup-phrase").placeholder = plan.confirmationPhrase;
  $("#cleanup-dialog").showModal();
}

function cleanupTargetLabel(target) {
  if (target.kind === "ticket_worktree") return t("ticketWorktree", { path: target.path });
  if (target.kind === "integration_worktree") return t("integrationWorktree", { path: target.path });
  if (target.kind === "branch") return t("branchTarget", { branch: target.branch });
  if (target.id === "database") return t("projectDatabase");
  if (target.id === "skills") return t("projectSkills");
  if (target.id === "metadata") return t("projectMetadata");
  if (target.kind === "registration") return t("globalRegistration");
  return target.label;
}

async function executeCleanup() {
  const plan = state.cleanupPlan;
  if (!plan) throw new Error(t("generateCleanupFirst"));
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
  if (target.id === "planning-new-messages") { scrollTranscriptToEnd(); return; }
  if (target.dataset.goTab) { selectTab(target.dataset.goTab); return; }
  if (target.dataset.project) { void action(() => selectProject(target.dataset.project), false); return; }
  if (target.dataset.onboard) { openWizard(target.dataset.onboard); return; }
  if (target.id === "refresh-preflight") { void action(async () => { state.preflight = await json("/api/preflight/refresh", mutation({})); renderHealth(); showLanding(); }, false); return; }
  if (!state.project) return;
  if (target.dataset.planningRetry) { void action(() => json(`${base()}/planning/sessions/${encodeURIComponent(target.dataset.planningRetry)}/actions`, mutation({ action: "retry" }))); return; }
  if (target.dataset.copySession) {
    const session = state.planning?.sessions.find((candidate) => candidate.id === target.dataset.copySession);
    if (session) void navigator.clipboard.writeText(`${session.errorCode || "planning.error"}\n${session.errorDetail || t("noDetail")}`).then(() => { target.textContent = t("copied"); });
    return;
  }
  if (target.dataset.openTicket) { selectTab("tickets"); return; }
  if (target.dataset.autoAction) {
    void action(async () => {
      const body = { action: target.dataset.autoAction, runId: state.auto?.run?.id };
      if (body.action === "start") {
        delete body.runId;
        if (state.inspection.dirty) {
          const proceed = window.confirm(t("dirtyAutoConfirm"));
          if (!proceed) return;
          body.dirtyPolicy = "committed-head";
        } else body.dirtyPolicy = "cancel";
      }
      await executeAutoAction(body);
    });
    return;
  }
  if (target.dataset.autoApprove !== undefined) { void action(showAutoWorkspaceApproval, false); return; }
  if (target.dataset.ticketAction) {
    void action(async () => {
      const body = { action: target.dataset.ticketAction };
      if (body.action === "confirm") body.attemptId = target.dataset.attempt;
      if (["run", "retry"].includes(body.action)) {
        if (!state.inspection.hasBaseCommit) throw new Error(t("baselineCommitRequired"));
        if (state.inspection.dirty) {
          const proceed = window.confirm(t("dirtyTicketConfirm"));
          if (!proceed) return;
          body.dirtyPolicy = "committed-head";
        } else body.dirtyPolicy = "cancel";
      }
      await executeTicketAction(target.dataset.ticket, body);
    });
    return;
  }
  if (target.id === "create-ticket") { void action(() => json(`${base()}/tickets`, mutation({ title: $("#ticket-title").value, description: $("#ticket-description").value, predecessorIds: $("#ticket-predecessors").value.split(",").map((item) => item.trim()).filter(Boolean) }))); return; }
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
$("#progress").addEventListener("click", (event) => {
  const target = event.target.closest("[data-progress-tab]");
  if (!target) return;
  selectTab(target.dataset.progressTab);
  const destination = target.dataset.progressTarget ? document.getElementById(target.dataset.progressTarget) : content;
  window.setTimeout(() => {
    destination?.focus({ preventScroll: true });
    destination?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, 0);
});
$("#content").addEventListener("submit", (event) => {
  if (event.target.id !== "planning-composer") return;
  event.preventDefault();
  void action(submitPlanningMessage, false);
});
$("#content").addEventListener("keydown", (event) => {
  if (event.target.id !== "planning-message" || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  event.target.form?.requestSubmit();
});
$("#content").addEventListener("scroll", (event) => {
  if (event.target.id !== "planning-transcript") return;
  transcriptPinned = event.target.scrollHeight - event.target.scrollTop - event.target.clientHeight < 48;
  if (transcriptPinned) {
    transcriptUnread = 0;
    updateNewMessagesButton();
  }
}, true);
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
  else if (result.status === "unavailable") $("#inspection").textContent = t("pathManual", { diagnostic: result.diagnostic });
}, false));
$("#execute-cleanup").addEventListener("click", () => void action(executeCleanup, false));
$("#approve-workspace").addEventListener("click", () => void action(async () => {
  const pending = state.pendingWorkspaceAction;
  if (!pending) throw new Error(t("noWorkspaceApproval"));
  $("#workspace-approval-dialog").close();
  state.pendingWorkspaceAction = null;
  const approvals = {
    ...(pending.preparationFingerprint ? { preparationApproval: { fingerprint: pending.preparationFingerprint, allowNetwork: true, allowInstallScripts: true, rememberForProject: true } } : {}),
    ...(pending.verificationFingerprint ? { verificationApproval: { fingerprint: pending.verificationFingerprint, allowVerification: true, rememberForProject: true } } : {}),
  };
  if (pending.request.auto) await executeAutoAction({ ...pending.request.body, ...approvals });
  else await executeTicketAction(pending.request.ticketId, { ...pending.request.body, ...approvals });
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
  void refreshPlanningSnapshot().catch(showNotice);
}, 1000);

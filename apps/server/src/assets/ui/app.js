const state = {
  preflight: null,
  memory: null,
  projects: [],
  project: null,
  projectEntry: null,
  inspection: null,
  wizardInspection: null,
  cleanupPlan: null,
  tab: "overview",
  tickets: [],
  dependencies: [],
  planning: null,
  capabilities: null,
};

const $ = (selector) => document.querySelector(selector);
const content = $("#content");
const errorBox = $("#error");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

function mutation(body) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function loadGlobal() {
  const [preflight, projects, memory] = await Promise.all([
    json("/api/preflight"),
    json("/api/projects"),
    json("/api/memory").catch(() => null),
  ]);
  state.preflight = preflight;
  state.projects = projects.projects;
  state.memory = memory;
  renderProjects();
  renderHealth();
}

function renderProjects() {
  $("#projects").innerHTML = state.projects.map((entry) => `
    <button class="project ${state.project?.id === entry.project.id ? "active" : ""}" data-project="${esc(entry.project.id)}">
      <strong><span class="state-dot ${esc(entry.state)}"></span>${esc(entry.project.name)}</strong>
      <small>${esc(entry.state)} · ${esc(entry.project.path)}</small>
    </button>`).join("") || '<p class="muted">No recent projects.</p>';
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
  $("#view-kicker").textContent = "Local workspace";
  $("#project-name").textContent = "Choose where to work";
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
  const [ticketData, dependencyData, planning, capabilities, inspection] = await Promise.all([
    json(`${base()}/tickets`), json(`${base()}/dependencies`), json(`${base()}/planning`), json(`${base()}/capabilities`), json(`${base()}/inspection`),
  ]);
  state.tickets = ticketData.tickets;
  state.dependencies = dependencyData.dependencies;
  state.planning = planning;
  state.capabilities = capabilities;
  state.inspection = inspection;
  render();
}

function render() {
  errorBox.textContent = "";
  const renderer = {
    overview: renderOverview, planning: renderPlanning, tickets: renderTickets, dag: renderDag,
    history: renderHistory, sessions: renderSessions, settings: renderSettings,
  }[state.tab];
  renderer();
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
  return `<article class="card"><div class="row"><h3>${esc(ticket.title)}</h3><span class="status ${esc(ticket.status)}">${esc(ticket.status)}</span></div><p>${esc(ticket.description)}</p><small class="muted">${esc(ticket.id)}${ticket.branch ? ` · ${esc(ticket.branch)}` : ""}</small>${ticket.review ? `<p><small>Review: ${esc(ticket.review.verdict)} — ${esc(ticket.review.summary)}</small></p>` : ""}${attempt?.diagnosticCode ? `<p class="error">${esc(attempt.diagnosticCode)} · ${esc(attempt.diagnosticDetail)}</p>` : ""}<div class="actions">${buttons.join("")}</div></article>`;
}

function renderOverview() {
  const counts = Object.fromEntries(state.tickets.map((ticket) => ticket.status).map((status) => [status, state.tickets.filter((ticket) => ticket.status === status).length]));
  const ready = eligibility();
  content.className = "stack";
  content.innerHTML = `
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
  const providerDisabled = planning.providerAvailable ? "" : "disabled";
  content.className = "stack";
  content.innerHTML = `
    <div class="planning-banner ${planning.providerAvailable ? "ready" : "offline"}">
      <strong>${planning.providerAvailable ? `${esc(state.capabilities?.provider || "Agent")} ready` : "Provider unavailable"}</strong>
      <span>Planning data and manual editing stay available${state.inspection?.hasBaseCommit ? "." : "; ticket execution waits for the first Git commit."}</span>
    </div>
    <div class="planning-layout">
      <section class="card conversation-panel">
        <div class="row"><div><p class="kicker">Conversation</p><h2>Shape the work together</h2></div><span class="status">${esc(planning.thread?.status || "not started")}</span></div>
        <div class="transcript">${planning.messages.filter((message) => message.role !== "system").map((message) => `
          <div class="message ${esc(message.role)}"><small>${esc(message.role)} · ${new Date(message.createdAt).toLocaleString()}</small><p>${esc(message.content)}</p></div>`).join("") || '<div class="empty compact">Start with the outcome you want. The conversation is stored locally.</div>'}</div>
        <div class="composer"><textarea id="planning-message" placeholder="Describe the goal, answer a question, or correct an assumption…" ${providerDisabled}></textarea><button id="send-planning-message" class="primary" ${providerDisabled}>Send</button></div>
      </section>
      <aside class="card operation-panel">
        <p class="kicker">Durable operation</p>
        ${active ? planningOperation(active, planning.events) : '<p class="muted">No generation is running.</p>'}
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

function renderTickets() {
  content.className = "stack";
  content.innerHTML = `<div class="grid">${state.tickets.map(ticketCard).join("") || '<div class="empty">No tickets.</div>'}</div><article class="card"><h3>Create ticket</h3><input id="ticket-title" placeholder="Title"><textarea id="ticket-description" placeholder="What this vertical slice delivers"></textarea><input id="ticket-predecessors" placeholder="Predecessor ids, comma separated"><button id="create-ticket" class="primary">Create</button></article>`;
}

function renderDag() {
  content.className = "stack";
  content.innerHTML = `<p class="muted">Read-only dependency graph. Only DONE satisfies an edge.</p><div class="dag">${state.tickets.map((ticket) => { const blockers = state.dependencies.filter((edge) => edge.ticketId === ticket.id).map((edge) => edge.predecessorId); return `<article class="card node"><div class="row"><strong>${esc(ticket.title)}</strong><span class="status ${esc(ticket.status)}">${esc(ticket.status)}</span></div><p class="edge">blocked by: ${blockers.map(esc).join(", ") || "none"}</p></article>`; }).join("")}</div>`;
}

async function renderHistory() {
  content.className = "stack";
  content.innerHTML = '<div class="empty">Loading history…</div>';
  const rows = await Promise.all(state.tickets.map(async (ticket) => ({ ticket, data: await json(`${base()}/tickets/${encodeURIComponent(ticket.id)}/history`) })));
  content.innerHTML = rows.map(({ ticket, data }) => `<article class="card"><h3>${esc(ticket.title)}</h3><pre>${esc(data.history.map((entry) => `${entry.createdAt}  ${entry.fromStatus || "∅"} → ${entry.toStatus}  ${entry.reason}`).join("\n"))}</pre></article>`).join("") || '<div class="empty">No history.</div>';
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
  const settings = await json(`${base()}/settings`);
  content.innerHTML = `<div class="grid"><article class="card"><h3>Effective</h3><pre>${esc(JSON.stringify(settings?.effective, null, 2))}</pre></article><article class="card"><h3>Capabilities</h3><pre>${esc(JSON.stringify(state.capabilities, null, 2))}</pre></article></div><article class="card"><h3>Project override</h3><textarea id="settings-override">${esc(JSON.stringify(settings?.override || {}, null, 2))}</textarea><button id="save-settings" class="primary">Validate and save</button></article><article class="card"><h3>Safe cleanup</h3><p>Preview registered worktrees, branches, metadata and global registration before deleting anything.</p><button id="plan-cleanup" class="danger-button">Build cleanup plan</button></article>`;
}

async function refreshPreview() {
  if (!state.project || !$("#preview")) return;
  const active = state.tickets.find((ticket) => ["RUNNING", "REVIEW", "CHANGES_REQUESTED", "READY_TO_MERGE"].includes(ticket.status));
  const status = await json(`${base()}/preview${active ? `?ticketId=${encodeURIComponent(active.id)}` : ""}`);
  if (!$("#preview")) return;
  $("#preview").innerHTML = status.url && status.running ? `<iframe class="preview-frame" src="${esc(status.url)}"></iframe>` : `<pre>${esc(status.diagnostic || status.logs || `Source: ${status.source}\n${status.root}`)}</pre>`;
}

async function action(operation, refresh = true) {
  errorBox.textContent = "";
  try {
    await operation();
    if (refresh && state.project) await refreshProject();
  } catch (error) {
    errorBox.textContent = error.message;
  }
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
  if (target.dataset.project) { void action(() => selectProject(target.dataset.project), false); return; }
  if (target.dataset.onboard) { openWizard(target.dataset.onboard); return; }
  if (target.id === "refresh-preflight") { void action(async () => { state.preflight = await json("/api/preflight/refresh", mutation({})); renderHealth(); showLanding(); }, false); return; }
  if (!state.project) return;
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
      await json(`${base()}/tickets/${encodeURIComponent(target.dataset.ticket)}/actions`, mutation(body));
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
  if (target.id === "save-settings") { void action(() => json(`${base()}/settings`, mutation({ override: JSON.parse($("#settings-override").value) }))); return; }
  if (target.id === "plan-cleanup") { void action(buildCleanupPlan, false); return; }
  if (target.dataset.preview) { const active = state.tickets.find((ticket) => ["RUNNING", "REVIEW", "CHANGES_REQUESTED", "READY_TO_MERGE"].includes(ticket.status)); void action(() => json(`${base()}/preview`, mutation({ action: target.dataset.preview, ticketId: active?.id }))); }
});
$("#nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (!button) return;
  state.tab = button.dataset.tab;
  document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === button));
  render();
});
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

async function boot() {
  try {
    await loadGlobal();
    showLanding();
    const hashProject = new URLSearchParams(location.hash.slice(1)).get("project");
    const prefilledPath = new URL(location.href).searchParams.get("path");
    if (hashProject) await selectProject(hashProject);
    else if (prefilledPath) openWizard("existing", prefilledPath);
  } catch (error) {
    errorBox.textContent = error.message;
  }
}

void boot();
setInterval(() => {
  if (state.project && ["overview", "tickets", "dag"].includes(state.tab)) void refreshProject().catch((error) => { errorBox.textContent = error.message; });
}, 2500);

setInterval(() => {
  if (!state.project || state.tab !== "planning") return;
  const editing = content.contains(document.activeElement) && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  void json(`${base()}/planning`).then((planning) => {
    state.planning = planning;
    if (!editing) renderPlanning();
  }).catch((error) => { errorBox.textContent = error.message; });
}, 1000);

import { t } from "./i18n.js";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

export function diagnosticFor(code) {
  const normalized = String(code ?? "").toLowerCase();
  if (normalized.includes("quota") || normalized.includes("usage_limit")) return { title: t("quotaTitle"), body: t("quotaBody"), action: "retry" };
  if (["codex.not_authenticated", "provider.not_authenticated"].includes(code)) {
    return { title: t("authTitle"), body: t("authBody"), action: "auth_help" };
  }
  if (["provider.unavailable", "planning.provider_unavailable"].includes(code)) {
    return { title: t("providerTitle"), body: t("providerBody"), action: "open_settings" };
  }
  if (normalized.includes("network") || normalized.includes("connection") || normalized.includes("timeout")) {
    return { title: t("networkTitle"), body: t("networkBody"), action: "retry" };
  }
  if (normalized.includes("cancel")) return { title: t("cancelledTitle"), body: t("cancelledBody"), action: null };
  if (normalized.startsWith("preparation.") || normalized.startsWith("workspace_preparation.")) {
    return { title: t("preparationTitle"), body: t("preparationBody"), action: "open_settings" };
  }
  if (normalized.startsWith("integration.")) {
    return { title: t("integrationTitle"), body: t("integrationBody"), action: "open_ticket" };
  }
  if (code === "planning.bootstrap_interrupted") return { title: t("interruptedTitle"), body: t("interruptedBody"), action: "resume" };
  return { title: t("genericTitle"), body: t("genericBody"), action: null };
}

export function nextAction(state) {
  if ((state.activity?.summary?.count ?? 0) > 0) return { label: t("resolveAttention"), tab: "activity" };
  const artifacts = state.planning?.artifacts ?? [];
  if ((state.planning?.messages?.length ?? 0) === 0) return { label: t("startIdea"), tab: "planning" };
  const spec = artifacts.filter((item) => item.kind === "spec").at(-1);
  if (!spec) return { label: t("continuePlan"), tab: "planning" };
  if (spec.status !== "approved") return { label: t("approveSpec"), tab: "planning" };
  const plan = artifacts.filter((item) => item.kind === "tickets").at(-1);
  if (!plan || !plan.confirmedAt) return { label: t("approveTickets"), tab: "planning" };
  if (state.tickets.some((ticket) => ticket.status === "READY")) return { label: t("runTicket"), tab: "tickets" };
  return { label: t("complete"), tab: "overview" };
}

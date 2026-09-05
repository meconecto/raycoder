const catalogs = {
  en: {
    projects: "Projects", runtime: "Runtime", addProject: "+ Add project", localWorkspace: "Local workspace",
    chooseWork: "Choose where to work", overview: "Overview", plan: "Plan", tickets: "Tickets", activity: "Activity",
    advanced: "Advanced", dag: "DAG", history: "History", sessions: "Sessions", settings: "Settings",
    language: "Language", theme: "Theme", automatic: "Automatic", spanish: "Español", english: "English",
    system: "System", light: "Light", dark: "Dark", dismiss: "Dismiss",
    errorTitle: "Something needs attention", technicalDetails: "Technical details", copyDiagnostic: "Copy diagnostic",
    copied: "Diagnostic copied", retry: "Retry", resume: "Resume", openTicket: "Open ticket", openSettings: "Open settings",
    quotaTitle: "Usage limit reached", quotaBody: "The provider has no usage available right now. Your conversation is saved; retry after the limit resets.",
    authTitle: "Codex needs sign-in", authBody: "Sign in to Codex again, then refresh diagnostics and retry.", authHelp: "Authentication help",
    providerTitle: "Provider unavailable", providerBody: "No executable provider is currently available. Check Runtime diagnostics, then retry.",
    networkTitle: "Provider connection failed", networkBody: "The provider could not be reached. Check the local connection and retry; the operation history is preserved.",
    cancelledTitle: "Operation cancelled", cancelledBody: "The operation was cancelled without discarding its durable history.",
    preparationTitle: "Workspace preparation needs attention", preparationBody: "Review the preparation plan, tools and approval in Settings before running this ticket again.",
    verificationTitle: "Workspace verification needs attention", verificationBody: "Review the verification commands, tools and approval in Settings before continuing this ticket.",
    integrationTitle: "Integration needs attention", integrationBody: "Open the ticket to review the durable integration diagnostic and choose the next safe action.",
    genericTitle: "Operation failed", genericBody: "Raycoder preserved the operation and its diagnostic. Review the technical details before retrying.",
    interruptedTitle: "Operation interrupted", interruptedBody: "Raycoder restarted before it could confirm the external process result.",
    noActivity: "No durable activity yet.", attention: "needs attention", nextAction: "Next action",
    startIdea: "Describe the feature you want to build", continuePlan: "Continue the planning conversation", approveSpec: "Review and approve the SPEC",
    approveTickets: "Review and confirm the ticket plan", runTicket: "Run the next ready ticket", resolveAttention: "Resolve the latest issue",
    complete: "All confirmed tickets are done", go: "Open", ideaPlan: "Idea / Plan", execution: "Execution", integration: "Integration",
    autoMode: "Auto mode", manualDefault: "Manual by default", autoDescription: "Opt in to run eligible tickets one at a time. Auto pauses on approvals, failures, provider limits or human intervention.",
    startAuto: "Start Auto", pauseAuto: "Pause", resumeAuto: "Resume Auto", stopAuto: "Stop Auto", approveAndResumeAuto: "Approve and resume",
    currentTicket: "Current ticket", plannedQueue: "Planned queue", emptyQueue: "No eligible tickets", none: "None", recentAutoEvents: "Recent Auto events",
  },
  es: {
    projects: "Proyectos", runtime: "Entorno", addProject: "+ Agregar proyecto", localWorkspace: "Workspace local",
    chooseWork: "Elegí dónde trabajar", overview: "Resumen", plan: "Plan", tickets: "Tickets", activity: "Actividad",
    advanced: "Avanzado", dag: "DAG", history: "Historial", sessions: "Sesiones", settings: "Ajustes",
    language: "Idioma", theme: "Tema", automatic: "Automático", spanish: "Español", english: "English",
    system: "Sistema", light: "Claro", dark: "Oscuro", dismiss: "Cerrar",
    errorTitle: "Algo requiere atención", technicalDetails: "Detalles técnicos", copyDiagnostic: "Copiar diagnóstico",
    copied: "Diagnóstico copiado", retry: "Reintentar", resume: "Reanudar", openTicket: "Abrir ticket", openSettings: "Abrir ajustes",
    quotaTitle: "Se agotó el límite de uso", quotaBody: "El proveedor no tiene uso disponible por ahora. La conversación quedó guardada; reintentá cuando se reinicie el límite.",
    authTitle: "Codex necesita iniciar sesión", authBody: "Volvé a iniciar sesión en Codex, actualizá los diagnósticos y reintentá.", authHelp: "Ayuda de autenticación",
    providerTitle: "Proveedor no disponible", providerBody: "No hay un proveedor ejecutable disponible. Revisá los diagnósticos del entorno y reintentá.",
    networkTitle: "Falló la conexión con el proveedor", networkBody: "No se pudo contactar al proveedor. Revisá la conexión local y reintentá; el historial de la operación quedó guardado.",
    cancelledTitle: "Operación cancelada", cancelledBody: "La operación fue cancelada sin descartar su historial durable.",
    preparationTitle: "La preparación del workspace requiere atención", preparationBody: "Revisá el plan, las herramientas y la autorización de preparación en Ajustes antes de volver a ejecutar el ticket.",
    verificationTitle: "La verificación del workspace requiere atención", verificationBody: "Revisá los comandos, las herramientas y la autorización de verificación en Ajustes antes de continuar el ticket.",
    integrationTitle: "La integración requiere atención", integrationBody: "Abrí el ticket para revisar el diagnóstico durable de integración y elegir la próxima acción segura.",
    genericTitle: "La operación falló", genericBody: "Raycoder conservó la operación y su diagnóstico. Revisá los detalles técnicos antes de reintentar.",
    interruptedTitle: "Operación interrumpida", interruptedBody: "Raycoder se reinició antes de poder confirmar el resultado del proceso externo.",
    noActivity: "Todavía no hay actividad durable.", attention: "requiere atención", nextAction: "Siguiente acción",
    startIdea: "Describí la funcionalidad que querés construir", continuePlan: "Continuá la conversación de planificación", approveSpec: "Revisá y aprobá la SPEC",
    approveTickets: "Revisá y confirmá el plan de tickets", runTicket: "Ejecutá el próximo ticket listo", resolveAttention: "Resolvé el último inconveniente",
    complete: "Todos los tickets confirmados están terminados", go: "Abrir", ideaPlan: "Idea / Plan", execution: "Ejecución", integration: "Integración",
    autoMode: "Modo Auto", manualDefault: "Manual por defecto", autoDescription: "Activá Auto para ejecutar de a un ticket elegible. Se pausa ante aprobaciones, fallos, límites del proveedor o intervención humana.",
    startAuto: "Iniciar Auto", pauseAuto: "Pausar", resumeAuto: "Reanudar Auto", stopAuto: "Detener Auto", approveAndResumeAuto: "Aprobar y reanudar",
    currentTicket: "Ticket actual", plannedQueue: "Cola prevista", emptyQueue: "No hay tickets elegibles", none: "Ninguno", recentAutoEvents: "Eventos Auto recientes",
  },
};

let preferences = { locale: "auto", theme: "system" };

export function configurePreferences(next) {
  preferences = next;
  const locale = resolvedLocale();
  document.documentElement.lang = locale;
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.style.colorScheme = preferences.theme === "system" ? "light dark" : preferences.theme;
}

export function resolvedLocale() {
  if (preferences.locale !== "auto") return preferences.locale;
  return navigator.language?.toLowerCase().startsWith("es") ? "es" : "en";
}

export function t(key) {
  return catalogs[resolvedLocale()][key] ?? catalogs.en[key] ?? key;
}

export function formatDate(value) {
  return new Intl.DateTimeFormat(resolvedLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

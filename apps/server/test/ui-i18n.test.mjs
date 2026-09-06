import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogs, configurePreferences, label, plural, t } from "../src/assets/ui/i18n.js";

const uiRoot = fileURLToPath(new URL("../src/assets/ui/", import.meta.url));

describe("UI localization", () => {
  it("keeps the English and Spanish catalogs symmetric", () => {
    expect(Object.keys(catalogs.es).sort()).toEqual(Object.keys(catalogs.en).sort());
  });

  it("resolves every statically referenced translation key", () => {
    const sources = ["app.js", "presentation.js", "index.html"]
      .map((file) => readFileSync(`${uiRoot}${file}`, "utf8"))
      .join("\n");
    const keys = new Set([
      ...[...sources.matchAll(/\bt\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
      ...[...sources.matchAll(/data-i18n(?:-placeholder|-aria-label)?=["']([^"']+)["']/g)].map((match) => match[1]),
    ]);
    for (const key of keys) {
      expect(catalogs.en, `English catalog is missing ${key}`).toHaveProperty(key);
      expect(catalogs.es, `Spanish catalog is missing ${key}`).toHaveProperty(key);
    }
  });

  it("interpolates, pluralizes and translates domain labels", () => {
    const documentElement = { lang: "", dataset: {}, style: {} };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement } });
    configurePreferences({ locale: "es", theme: "dark" });

    expect(t("ticketCounts", { total: 3, done: 1, ready: 2 })).toBe("3 total · 1 terminados · 2 listos");
    expect(plural("newMessages", 1)).toBe("1 mensaje nuevo");
    expect(plural("newMessages", 2)).toBe("2 mensajes nuevos");
    expect(label("status", "RUNNING")).toBe("en curso");
    expect(label("event", "command")).toBe("Comando");
    expect(label("status", "FUTURE_STATE")).toBe("FUTURE_STATE");
    expect(documentElement.lang).toBe("es");
    expect(documentElement.dataset.theme).toBe("dark");
  });

  it("does not regress the reported untranslated UI literals", () => {
    const app = readFileSync(`${uiRoot}app.js`, "utf8");
    for (const literal of [
      ">Open a repository, or start with an empty folder.<",
      ">Shape the work together<",
      ">Generate SPEC from conversation<",
      ">No tickets.<",
      ">Project configuration<",
    ]) expect(app).not.toContain(literal);
  });
});

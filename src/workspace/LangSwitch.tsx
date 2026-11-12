// Interface language switcher (top bar): EN / ҚАЗ / РУС. The choice is remembered in this browser.
import { LANGS, lang, setLang, t } from "../i18n";

export function LangSwitch() {
  const cur = lang.value;
  return (
    <select class="ws-lang" value={cur} aria-label={t("Interface language")} title={t("Interface language")} onChange={(e) => setLang(e.currentTarget.value as typeof cur)}>
      {LANGS.map((l) => (
        <option key={l.id} value={l.id} title={l.name}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

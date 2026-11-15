// {§splurnk-identity-oidc} Progressive OTM enhancement for Tasks <-> Chat view switching.
import { $$, route, the } from "on_the_money";

await the.boot({
    locale: document.documentElement.lang,
    defaultLocale: document.documentElement.lang,
    persistKeys: [],
});

if (the("auth-state") === "signed-in") {
    route(
        (_pathname, search) => {
            const requested = new URLSearchParams(search).get("view");
            const activeView = requested === "chat" ? "chat" : "tasks";
            the("view", activeView);
            for (const link of $$("[data-view-link]")) {
                if (link.getAttribute("data-view-link") === activeView) {
                    link.setAttribute("aria-current", "page");
                } else {
                    link.removeAttribute("aria-current");
                }
            }
        },
        { match: "[data-route]", initial: false },
    );
}

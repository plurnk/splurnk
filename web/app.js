// {§splurnk-identity-oidc} {§splurnk-chat-seam}
// Progressive OTM enhancement for Tasks <-> Chat view switching while preserving room scope.
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
            for (const roomLink of $$("[data-room-link]")) {
                const href = roomLink.getAttribute("href");
                if (!href) continue;
                const nextUrl = new URL(href, location.origin);
                nextUrl.searchParams.set("view", activeView);
                roomLink.setAttribute("href", `${nextUrl.pathname}${nextUrl.search}`);
            }
        },
        { match: "[data-route]", initial: false },
    );
}

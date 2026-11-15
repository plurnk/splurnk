// {§splurnk-http-lifecycle} {§splurnk-identity-oidc} {§splurnk-deployment-boundary}
// Typed semantic HTML document renderer backed by the Vite-built index.html shell.
import type { SplurnkConfig } from "./Config.ts";
import type { EnrolledRoom, MemberRecord } from "./Database.ts";

export type ViewMode = "tasks" | "chat";

export function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

interface DocumentSlots {
    readonly title: string;
    readonly authState: "signed-out" | "signed-in";
    readonly view: ViewMode;
    readonly headerInner: string;
    readonly mainInner: string;
}

interface CompiledShell {
    render(slots: DocumentSlots): string;
}

function locateUniqueSpan(
    html: string,
    pattern: RegExp,
    description: string,
): { readonly start: number; readonly end: number } {
    const matches = [...html.matchAll(pattern)];
    if (matches.length !== 1 || matches[0].index === undefined) {
        throw new Error(`Web index.html shell must contain exactly one ${description}.`);
    }
    return {
        start: matches[0].index,
        end: matches[0].index + matches[0][0].length,
    };
}

function compileShell(indexHtml: string): CompiledShell {
    const titleSpan = locateUniqueSpan(indexHtml, /<title>[\s\S]*?<\/title>/gu, "<title> element");
    const bodyOpenSpan = locateUniqueSpan(indexHtml, /<body\b[^>]*>/gu, "<body> opening tag");
    const headerSpan = locateUniqueSpan(
        indexHtml,
        /<header\s+id="app-header">[\s\S]*?<\/header>/gu,
        '<header id="app-header"> element',
    );
    const mainSpan = locateUniqueSpan(
        indexHtml,
        /<main\s+id="main">[\s\S]*?<\/main>/gu,
        '<main id="main"> element',
    );

    if (
        !(
            titleSpan.end <= bodyOpenSpan.start &&
            bodyOpenSpan.end <= headerSpan.start &&
            headerSpan.end <= mainSpan.start
        )
    ) {
        throw new Error("Web index.html shell slots are out of expected document order.");
    }

    const prefix = indexHtml.slice(0, titleSpan.start);
    const titleToBody = indexHtml.slice(titleSpan.end, bodyOpenSpan.start);
    const bodyToHeader = indexHtml.slice(bodyOpenSpan.end, headerSpan.start);
    const headerToMain = indexHtml.slice(headerSpan.end, mainSpan.start);
    const suffix = indexHtml.slice(mainSpan.end);

    return {
        render(slots: DocumentSlots): string {
            return (
                `${prefix}<title>${escapeHtml(slots.title)}</title>` +
                `${titleToBody}<body data-auth-state="${slots.authState}" data-view="${slots.view}">` +
                `${bodyToHeader}<header id="app-header">${slots.headerInner}</header>` +
                `${headerToMain}<main id="main">${slots.mainInner}</main>${suffix}`
            );
        },
    };
}

function initialsFor(displayName: string): string {
    const parts = displayName.trim().split(/\s+/u).filter(Boolean);
    const raw =
        parts.length >= 2
            ? `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`
            : (parts[0]?.slice(0, 2) ?? "?");
    return raw.toUpperCase();
}

function renderMemberAvatar(member: MemberRecord): string {
    if (member.avatarUrl !== null) {
        return `<img src="${escapeHtml(member.avatarUrl)}" alt="" width="28" height="28" data-avatar referrerpolicy="no-referrer">`;
    }
    return `<span data-avatar-initials aria-hidden="true">${escapeHtml(initialsFor(member.displayName))}</span>`;
}

function renderBrand(): string {
    return `<a href="/" data-brand><img src="/icons/splurnk.svg" alt="" width="28" height="28"><span>Splurnk</span></a>`;
}

export interface SignInDocumentProps {
    readonly config: SplurnkConfig;
    readonly oidcConfigured: boolean;
    readonly returnTo: string;
}

export interface WorkspaceDocumentProps {
    readonly config: SplurnkConfig;
    readonly member: MemberRecord;
    readonly csrfToken: string;
    readonly rooms: readonly EnrolledRoom[];
    readonly activeView: ViewMode;
}

export default class Documents {
    readonly #shell: CompiledShell;

    constructor(indexHtml: string) {
        this.#shell = compileShell(indexHtml);
    }

    renderSignIn(props: SignInDocumentProps): string {
        const handle = escapeHtml(`@${props.config.botHandle}`);
        const origin = escapeHtml(props.config.publicOrigin);
        const loginHref =
            props.returnTo === "/"
                ? "/auth/login"
                : `/auth/login?${new URLSearchParams({ return: props.returnTo }).toString()}`;

        const actionMarkup = props.oidcConfigured
            ? `<p><a href="${escapeHtml(loginHref)}" role="button">Sign in with Telegram</a></p>`
            : `<p role="status"><small>Telegram OIDC sign-in is not yet configured on <code>${origin}</code> (supply <code>TELEGRAM_OIDC_CLIENT_ID</code> and <code>TELEGRAM_OIDC_CLIENT_SECRET</code> in <code>.env.keys</code>).</small></p>`;

        const mainInner = `
      <article>
        <header>
          <h1>Coordinate group tasks with ${handle}</h1>
        </header>
        <p>Add <code>${handle}</code> to your Telegram group, then sign in here to view shared tasks, streaks, and your dedicated Plurnk planning chat.</p>
        ${actionMarkup}
        <footer>
          <small>Serving <code>${origin}</code> · Direct messages from <code>${handle}</code> are outbound notifications only.</small>
        </footer>
      </article>`;

        return this.#shell.render({
            title: "Splurnk — Sign in",
            authState: "signed-out",
            view: "tasks",
            headerInner: renderBrand(),
            mainInner,
        });
    }

    renderWorkspace(props: WorkspaceDocumentProps): string {
        const handle = escapeHtml(`@${props.config.botHandle}`);
        const displayName = escapeHtml(props.member.displayName);
        const handleSuffix =
            props.member.username !== null
                ? ` <small>(@${escapeHtml(props.member.username)})</small>`
                : "";
        const tasksCurrent = props.activeView === "tasks" ? ' aria-current="page"' : "";
        const chatCurrent = props.activeView === "chat" ? ' aria-current="page"' : "";

        const headerInner = `${renderBrand()}
      <nav aria-label="Primary navigation">
        <ul>
          <li data-mode-switch data-signed-in-only>
            <a href="/?view=tasks" data-route data-view-link="tasks"${tasksCurrent}>Tasks</a>
            <a href="/?view=chat" data-route data-view-link="chat"${chatCurrent}>Chat</a>
          </li>
          <li>
            <span data-member-badge>
              ${renderMemberAvatar(props.member)}
              <span>${displayName}${handleSuffix}</span>
            </span>
          </li>
          <li>
            <form method="post" action="/auth/logout">
              <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
              <button type="submit" data-signout>Sign out</button>
            </form>
          </li>
        </ul>
      </nav>`;

        const roomsSection =
            props.rooms.length === 0
                ? `<article>
          <header><strong>No Telegram groups enrolled yet</strong></header>
          <p>Invite <code>${handle}</code> to a Telegram group and mention <code>${handle}</code> so your room workspace appears here.</p>
        </article>`
                : `<ul data-room-list aria-label="Enrolled rooms">${props.rooms
                      .map(
                          (room) => `<li>
            <article data-room-card>
              <header>
                <strong>${escapeHtml(room.title)}</strong>
                <small data-role-badge="${escapeHtml(room.role)}">${escapeHtml(room.role)}</small>
              </header>
              <small>Workspace <code>${escapeHtml(room.plurnkWorkspace)}</code> · ${escapeHtml(room.timezone)}</small>
            </article>
          </li>`,
                      )
                      .join("")}</ul>`;

        const mainInner = `
      ${roomsSection}
      <section id="panel-tasks" data-panel="tasks" aria-labelledby="heading-tasks">
        <div data-panel-toolbar>
          <h1 id="heading-tasks">Tasks</h1>
          <button type="button" disabled title="Task creation unlocks once a room is selected">New</button>
        </div>
        <p>Assigned group tasks across your enrolled rooms appear here.</p>
      </section>
      <section id="panel-chat" data-panel="chat" aria-labelledby="heading-chat">
        <div data-panel-toolbar>
          <h1 id="heading-chat">Chat with ${handle}</h1>
        </div>
        <p>Direct planning messages here route to your dedicated Plurnk session (<code>#u_${props.member.id}</code>).</p>
      </section>`;

        return this.#shell.render({
            title: "Splurnk",
            authState: "signed-in",
            view: props.activeView,
            headerInner,
            mainInner,
        });
    }
}

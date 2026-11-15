// {§splurnk-web-shell} {§splurnk-http-lifecycle} {§splurnk-identity-oidc} {§splurnk-chat-seam} {§splurnk-deployment-boundary}
// Spartan semantic HTML document renderer backed by the Vite-built index.html shell.
import type { SplurnkConfig } from "./Config.ts";
import type {
    EnrolledRoom,
    MemberRecord,
    RoomRecord,
    RoomRosterMember,
} from "./Database.ts";

export type ViewMode = "tasks" | "chat";

const BRAND_LINK =
    '<a href="/" title="Home"><img src="/icons/splurnk.svg" width="32" height="32" alt="Splurnk"></a>';
const SIGNOUT_ICON =
    '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11l3-3-3-3M13.5 8H6.5"/></svg>';

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

function formatMemberLabel(
    member: Pick<MemberRecord, "displayName" | "username">,
): string {
    return member.username !== null
        ? `${member.displayName} (@${member.username})`
        : member.displayName;
}

function renderMemberAvatar(
    member: Pick<MemberRecord, "avatarUrl" | "displayName" | "username">,
): string {
    const label = escapeHtml(formatMemberLabel(member));
    if (member.avatarUrl !== null) {
        return `<img src="${escapeHtml(member.avatarUrl)}" alt="${label}" title="${label}" width="32" height="32" data-avatar referrerpolicy="no-referrer">`;
    }
    return `<span data-avatar-initials role="img" aria-label="${label}" title="${label}">${escapeHtml(initialsFor(member.displayName))}</span>`;
}

function renderSessionNav(
    member: MemberRecord,
    csrfToken: string,
    modeItemsHtml = "",
): string {
    return `<nav aria-label="Main navigation">
        <ul>${modeItemsHtml}
          <li>${renderMemberAvatar(member)}</li>
          <li>
            <form method="post" action="/auth/logout">
              <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
              <button type="submit" aria-label="Sign out" title="Sign out" data-signout>${SIGNOUT_ICON}</button>
            </form>
          </li>
        </ul>
      </nav>`;
}

function buildWorkspaceHref(roomId: number | null, view: ViewMode): string {
    const params = new URLSearchParams();
    if (roomId !== null) {
        params.set("room", String(roomId));
    }
    params.set("view", view);
    return `/?${params.toString()}`;
}

export interface SignInDocumentProps {
    readonly oidcConfigured: boolean;
    readonly returnTo: string;
}

export interface WorkspaceDocumentProps {
    readonly config: SplurnkConfig;
    readonly member: MemberRecord;
    readonly csrfToken: string;
    readonly rooms: readonly EnrolledRoom[];
    readonly selectedRoom: EnrolledRoom | null;
    readonly selectedRoomRoster: readonly RoomRosterMember[];
    readonly activeView: ViewMode;
}

export interface RoomJoinDocumentProps {
    readonly room: RoomRecord;
    readonly joinCode: string;
    readonly oidcConfigured: boolean;
    readonly chatConfigured: boolean;
    readonly member: MemberRecord | null;
    readonly csrfToken: string | null;
    readonly alreadyEnrolled: boolean;
}

export default class Documents {
    readonly #shell: CompiledShell;

    constructor(indexHtml: string) {
        this.#shell = compileShell(indexHtml);
    }

    renderSignIn(props: SignInDocumentProps): string {
        const loginHref =
            props.returnTo === "/"
                ? "/auth/login"
                : `/auth/login?${new URLSearchParams({ return: props.returnTo }).toString()}`;

        const mainInner = props.oidcConfigured
            ? `<p><a href="${escapeHtml(loginHref)}" role="button">Sign in with Telegram</a></p>`
            : `<p role="status">Sign-in unavailable.</p>`;

        return this.#shell.render({
            title: "Splurnk",
            authState: "signed-out",
            view: "tasks",
            headerInner: BRAND_LINK,
            mainInner,
        });
    }

    renderWorkspace(props: WorkspaceDocumentProps): string {
        if (props.rooms.length === 0) {
            return this.#shell.render({
                title: "Splurnk",
                authState: "signed-in",
                view: props.activeView,
                headerInner: `${BRAND_LINK}${renderSessionNav(props.member, props.csrfToken)}`,
                mainInner: "<p>No rooms.</p>",
            });
        }

        const selectedRoomId = props.selectedRoom?.id ?? null;
        const tasksHref = escapeHtml(buildWorkspaceHref(selectedRoomId, "tasks"));
        const chatHref = escapeHtml(buildWorkspaceHref(selectedRoomId, "chat"));
        const tasksCurrent = props.activeView === "tasks" ? ' aria-current="page"' : "";
        const chatCurrent = props.activeView === "chat" ? ' aria-current="page"' : "";

        const roomNav = `<nav aria-label="Rooms" data-room-switcher>
        <ul>
          <li><a href="${escapeHtml(buildWorkspaceHref(null, props.activeView))}" data-room-link${props.selectedRoom === null ? ' aria-current="page"' : ""}>All</a></li>${props.rooms
              .map((room) => {
                  const isCurrent =
                      props.selectedRoom?.id === room.id ? ' aria-current="page"' : "";
                  const roomHref = escapeHtml(buildWorkspaceHref(room.id, props.activeView));
                  return `
          <li><a href="${roomHref}" data-room-link${isCurrent}>${escapeHtml(room.title)}</a></li>`;
              })
              .join("")}
        </ul>
      </nav>`;

        const modeItems = `
          <li data-mode-switch data-signed-in-only>
            <a href="${tasksHref}" data-route data-view-link="tasks"${tasksCurrent}>Tasks</a>
            <a href="${chatHref}" data-route data-view-link="chat"${chatCurrent}>Chat</a>
          </li>`;

        const roomDetails =
            props.selectedRoom !== null
                ? this.#renderSelectedRoomDetails(
                      props.config,
                      props.selectedRoom,
                      props.selectedRoomRoster,
                      props.csrfToken,
                  )
                : "";

        const mainInner = `${roomDetails}
      <section id="panel-tasks" data-panel="tasks" aria-label="Tasks">
        <div data-panel-toolbar>
          <button type="button" disabled>New</button>
        </div>
        <p>No tasks.</p>
      </section>
      <section id="panel-chat" data-panel="chat" aria-label="Chat">
        <p>No messages.</p>
      </section>`;

        return this.#shell.render({
            title:
                props.selectedRoom !== null
                    ? `${props.selectedRoom.title} — Splurnk`
                    : "Splurnk",
            authState: "signed-in",
            view: props.activeView,
            headerInner: `${BRAND_LINK}${roomNav}${renderSessionNav(props.member, props.csrfToken, modeItems)}`,
            mainInner,
        });
    }

    renderRoomJoin(props: RoomJoinDocumentProps): string {
        const roomTitle = escapeHtml(props.room.title);
        const joinPath = `/rooms/join/${encodeURIComponent(props.joinCode)}`;

        if (props.member === null || props.csrfToken === null) {
            const loginHref = `/auth/login?${new URLSearchParams({ return: joinPath }).toString()}`;
            const actionMarkup = props.oidcConfigured
                ? `<p><a href="${escapeHtml(loginHref)}" role="button">Sign in with Telegram</a></p>`
                : `<p role="status">Sign-in unavailable.</p>`;

            return this.#shell.render({
                title: `${props.room.title} — Splurnk`,
                authState: "signed-out",
                view: "tasks",
                headerInner: BRAND_LINK,
                mainInner: `<article><h1>${roomTitle}</h1>${actionMarkup}</article>`,
            });
        }

        const enrollmentAction = props.alreadyEnrolled
            ? `<p><a href="${escapeHtml(buildWorkspaceHref(props.room.id, "tasks"))}" role="button">Open</a></p>`
            : props.chatConfigured
              ? `<form method="post" action="${escapeHtml(joinPath)}">
          <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
          <button type="submit">Join</button>
        </form>`
              : `<p role="status">Verification unavailable.</p>`;

        return this.#shell.render({
            title: `${props.room.title} — Splurnk`,
            authState: "signed-in",
            view: "tasks",
            headerInner: `${BRAND_LINK}${renderSessionNav(props.member, props.csrfToken)}`,
            mainInner: `<article><h1>${roomTitle}</h1>${enrollmentAction}</article>`,
        });
    }

    #renderSelectedRoomDetails(
        config: SplurnkConfig,
        room: EnrolledRoom,
        roster: readonly RoomRosterMember[],
        csrfToken: string,
    ): string {
        const joinLinkMarkup =
            room.joinCode !== null
                ? `<p><code>${escapeHtml(`${config.publicOrigin}/rooms/join/${room.joinCode}`)}</code></p>`
                : "";
        const rotateFormMarkup =
            room.role === "admin"
                ? `<form method="post" action="/rooms/${room.id}/rotate-join-link" data-inline-form>
            <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
            <button type="submit">Rotate join link</button>
          </form>`
                : "";
        const rosterMarkup =
            roster.length === 0
                ? ""
                : `<ul data-roster-list aria-label="Members">${roster
                      .map(
                          (entry) =>
                              `<li><span>${escapeHtml(entry.displayName)}</span> <small data-role-badge="${escapeHtml(entry.role)}">${escapeHtml(entry.role)}</small></li>`,
                      )
                      .join("")}</ul>`;

        return `<details data-room-meta>
        <summary>${escapeHtml(room.title)} <small data-role-badge="${escapeHtml(room.role)}">${escapeHtml(room.role)}</small></summary>
        ${rosterMarkup}
        ${joinLinkMarkup}
        ${rotateFormMarkup}
      </details>`;
    }
}

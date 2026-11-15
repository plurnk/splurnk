// {§splurnk-http-lifecycle} {§splurnk-identity-oidc} {§splurnk-chat-seam} {§splurnk-deployment-boundary}
// Typed semantic HTML document renderer backed by the Vite-built index.html shell.
import type { SplurnkConfig } from "./Config.ts";
import type {
    EnrolledRoom,
    MemberRecord,
    RoomRecord,
    RoomRosterMember,
} from "./Database.ts";

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

function renderMemberAvatar(member: Pick<MemberRecord, "avatarUrl" | "displayName">): string {
    if (member.avatarUrl !== null) {
        return `<img src="${escapeHtml(member.avatarUrl)}" alt="" width="28" height="28" data-avatar referrerpolicy="no-referrer">`;
    }
    return `<span data-avatar-initials aria-hidden="true">${escapeHtml(initialsFor(member.displayName))}</span>`;
}

function renderBrand(): string {
    return `<a href="/" data-brand><img src="/icons/splurnk.svg" alt="" width="28" height="28"><span>Splurnk</span></a>`;
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
    readonly config: SplurnkConfig;
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
    readonly config: SplurnkConfig;
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
        const selectedRoomId = props.selectedRoom?.id ?? null;
        const tasksHref = escapeHtml(buildWorkspaceHref(selectedRoomId, "tasks"));
        const chatHref = escapeHtml(buildWorkspaceHref(selectedRoomId, "chat"));
        const tasksCurrent = props.activeView === "tasks" ? ' aria-current="page"' : "";
        const chatCurrent = props.activeView === "chat" ? ' aria-current="page"' : "";

        const headerInner = `${renderBrand()}
      <nav aria-label="Primary navigation">
        <ul>
          <li data-mode-switch data-signed-in-only>
            <a href="${tasksHref}" data-route data-view-link="tasks"${tasksCurrent}>Tasks</a>
            <a href="${chatHref}" data-route data-view-link="chat"${chatCurrent}>Chat</a>
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

        const switcherSection =
            props.rooms.length === 0
                ? ""
                : `<nav aria-label="Enrolled rooms" data-room-switcher>
        <ul>
          <li>
            <a href="${escapeHtml(buildWorkspaceHref(null, props.activeView))}" data-room-link${props.selectedRoom === null ? ' aria-current="true"' : ""}>All rooms</a>
          </li>${props.rooms
              .map((room) => {
                  const isCurrent =
                      props.selectedRoom?.id === room.id ? ' aria-current="true"' : "";
                  const roomHref = escapeHtml(buildWorkspaceHref(room.id, props.activeView));
                  return `
          <li>
            <a href="${roomHref}" data-room-link${isCurrent}>${escapeHtml(room.title)} <small data-role-badge="${escapeHtml(room.role)}">${escapeHtml(room.role)}</small></a>
          </li>`;
              })
              .join("")}
        </ul>
      </nav>`;

        const roomsSection =
            props.rooms.length === 0
                ? `<article>
          <header><strong>No Telegram groups enrolled yet</strong></header>
          <p>Invite <code>${handle}</code> to a Telegram group and mention <code>${handle}</code> (or follow a room invite link) so your room workspace appears here.</p>
        </article>`
                : props.selectedRoom !== null
                  ? this.#renderSelectedRoomCard(
                        props.config,
                        props.selectedRoom,
                        props.selectedRoomRoster,
                        props.csrfToken,
                    )
                  : `<ul data-room-list aria-label="Room summaries">${props.rooms
                        .map(
                            (room) => `<li>
            <article data-room-card>
              <header>
                <a href="${escapeHtml(buildWorkspaceHref(room.id, props.activeView))}"><strong>${escapeHtml(room.title)}</strong></a>
                <small data-role-badge="${escapeHtml(room.role)}">${escapeHtml(room.role)}</small>
              </header>
              <small>Workspace <code>${escapeHtml(room.plurnkWorkspace)}</code> · ${escapeHtml(room.timezone)}</small>
            </article>
          </li>`,
                        )
                        .join("")}</ul>`;

        const taskHeading =
            props.selectedRoom !== null
                ? `Tasks · ${escapeHtml(props.selectedRoom.title)}`
                : "Tasks";
        const chatRoom = props.selectedRoom ?? props.rooms[0] ?? null;
        const chatHeading =
            chatRoom !== null
                ? `Chat with ${handle} · ${escapeHtml(chatRoom.title)}`
                : `Chat with ${handle}`;
        const chatDescription =
            chatRoom !== null
                ? `<p>Direct planning messages here route to your isolated room session (<code>${escapeHtml(chatRoom.plurnkWorkspace)}#u_${props.member.id}</code>).</p>`
                : `<p>Enroll in a Telegram group with <code>${handle}</code> to open your dedicated room planning session.</p>`;

        const mainInner = `
      ${switcherSection}
      ${roomsSection}
      <section id="panel-tasks" data-panel="tasks" aria-labelledby="heading-tasks">
        <div data-panel-toolbar>
          <h1 id="heading-tasks">${taskHeading}</h1>
          <button type="button" disabled title="Task creation lands in #5">New</button>
        </div>
        <p>Assigned group tasks for your active room scope appear here.</p>
      </section>
      <section id="panel-chat" data-panel="chat" aria-labelledby="heading-chat">
        <div data-panel-toolbar>
          <h1 id="heading-chat">${chatHeading}</h1>
        </div>
        ${chatDescription}
      </section>`;

        return this.#shell.render({
            title:
                props.selectedRoom !== null
                    ? `Splurnk — ${props.selectedRoom.title}`
                    : "Splurnk",
            authState: "signed-in",
            view: props.activeView,
            headerInner,
            mainInner,
        });
    }

    renderRoomJoin(props: RoomJoinDocumentProps): string {
        const handle = escapeHtml(`@${props.config.botHandle}`);
        const roomTitle = escapeHtml(props.room.title);
        const joinPath = `/rooms/join/${encodeURIComponent(props.joinCode)}`;

        if (props.member === null || props.csrfToken === null) {
            const loginHref = `/auth/login?${new URLSearchParams({ return: joinPath }).toString()}`;
            const actionMarkup = props.oidcConfigured
                ? `<p><a href="${escapeHtml(loginHref)}" role="button">Sign in with Telegram to join</a></p>`
                : `<p role="status"><small>Telegram OIDC sign-in is not yet configured on <code>${escapeHtml(props.config.publicOrigin)}</code>.</small></p>`;

            const mainInner = `
      <article>
        <header>
          <h1>Join &ldquo;${roomTitle}&rdquo; on Splurnk</h1>
        </header>
        <p>Sign in with Telegram so <code>${handle}</code> can verify your live membership in <strong>${roomTitle}</strong> and unlock its shared task board.</p>
        ${actionMarkup}
      </article>`;

            return this.#shell.render({
                title: `Splurnk — Join ${props.room.title}`,
                authState: "signed-out",
                view: "tasks",
                headerInner: renderBrand(),
                mainInner,
            });
        }

        const headerInner = `${renderBrand()}
      <nav aria-label="Primary navigation">
        <ul>
          <li>
            <span data-member-badge>
              ${renderMemberAvatar(props.member)}
              <span>${escapeHtml(props.member.displayName)}</span>
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

        const enrollmentAction = props.alreadyEnrolled
            ? `<p><a href="${escapeHtml(buildWorkspaceHref(props.room.id, "tasks"))}" role="button">Open ${roomTitle}</a></p>`
            : props.chatConfigured
              ? `<form method="post" action="${escapeHtml(joinPath)}">
          <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
          <button type="submit">Verify membership &amp; join ${roomTitle}</button>
        </form>`
              : `<p role="status"><small>Chat membership verification is not configured on this instance yet.</small></p>`;

        const mainInner = `
      <article>
        <header>
          <h1>Join &ldquo;${roomTitle}&rdquo;</h1>
        </header>
        <p>Signed in as <strong>${escapeHtml(props.member.displayName)}</strong>. Confirming checks live membership in <strong>${roomTitle}</strong> via <code>${handle}</code>.</p>
        ${enrollmentAction}
      </article>`;

        return this.#shell.render({
            title: `Splurnk — Join ${props.room.title}`,
            authState: "signed-in",
            view: "tasks",
            headerInner,
            mainInner,
        });
    }

    #renderSelectedRoomCard(
        config: SplurnkConfig,
        room: EnrolledRoom,
        roster: readonly RoomRosterMember[],
        csrfToken: string,
    ): string {
        const joinLinkMarkup =
            room.joinCode !== null
                ? `<p><small>Group enrollment link: <code>${escapeHtml(`${config.publicOrigin}/rooms/join/${room.joinCode}`)}</code></small></p>`
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
                : `<ul data-roster-list aria-label="Enrolled room members">${roster
                      .map(
                          (entry) =>
                              `<li><span>${escapeHtml(entry.displayName)}</span> <small data-role-badge="${escapeHtml(entry.role)}">${escapeHtml(entry.role)}</small></li>`,
                      )
                      .join("")}</ul>`;

        return `<article data-room-card>
        <header>
          <strong>${escapeHtml(room.title)}</strong>
          <small data-role-badge="${escapeHtml(room.role)}">${escapeHtml(room.role)}</small>
        </header>
        <small>Workspace <code>${escapeHtml(room.plurnkWorkspace)}</code> · ${escapeHtml(room.timezone)}</small>
        ${rosterMarkup}
        ${joinLinkMarkup}
        ${rotateFormMarkup}
      </article>`;
    }
}

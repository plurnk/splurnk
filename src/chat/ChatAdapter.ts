// {§splurnk-chat-seam} {§splurnk-deployment-boundary}
// Provider-neutral chat adapter contract decoupling domain rooms and notifications from Telegram.

export type ChatRoomRole = "admin" | "member";

export interface ChatRoomProfile {
    readonly provider: string;
    readonly externalChatId: string;
    readonly title: string;
    readonly avatarUrl: string | null;
}

export interface ChatParticipantProfile {
    readonly provider: string;
    readonly externalSubject: string;
    readonly username: string | null;
    readonly displayName: string;
    readonly avatarUrl: string | null;
    readonly isBot: boolean;
}

export type ChatInboundEvent =
    | {
          readonly kind: "bot_room_joined";
          readonly room: ChatRoomProfile;
          readonly actor: ChatParticipantProfile | null;
      }
    | {
          readonly kind: "bot_room_left";
          readonly provider: string;
          readonly externalChatId: string;
      }
    | {
          readonly kind: "room_migrated";
          readonly provider: string;
          readonly oldExternalChatId: string;
          readonly newExternalChatId: string;
      }
    | {
          readonly kind: "member_updated";
          readonly room: ChatRoomProfile;
          readonly member: ChatParticipantProfile;
          readonly membership: ChatRoomRole | null;
      }
    | {
          readonly kind: "room_mention";
          readonly room: ChatRoomProfile;
          readonly sender: ChatParticipantProfile;
          readonly externalMessageId: string;
          readonly promptText: string;
      }
    | {
          readonly kind: "direct_message";
          readonly externalChatId: string;
          readonly sender: ChatParticipantProfile;
          readonly text: string;
      };

export interface SendMessageOptions {
    readonly replyToExternalMessageId?: string;
}

export default interface ChatAdapter {
    readonly provider: string;
    verifyRoomMember(externalChatId: string, externalSubject: string): Promise<ChatRoomRole | null>;
    listRoomAdmins(externalChatId: string): Promise<readonly ChatParticipantProfile[]>;
    sendRoomMessage(
        externalChatId: string,
        text: string,
        options?: SendMessageOptions,
    ): Promise<void>;
    sendDirectNotification(externalSubject: string, text: string): Promise<void>;
}

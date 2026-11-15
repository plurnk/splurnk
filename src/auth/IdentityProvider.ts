// {§splurnk-identity-oidc} Transport-neutral OIDC identity provider contract.

export interface IdentityProfile {
    readonly subject: string;
    readonly username: string | null;
    readonly displayName: string;
    readonly avatarUrl: string | null;
}

export interface OidcTransaction {
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly returnTo: string;
    readonly expiresAt: number;
}

export interface AuthorizationBegin {
    readonly authorizationUrl: URL;
    readonly transaction: OidcTransaction;
}

export default interface IdentityProvider {
    begin(returnTo: string, expiresAt: number): Promise<AuthorizationBegin>;
    finish(callbackUrl: URL, transaction: OidcTransaction): Promise<IdentityProfile>;
}

// {§splurnk-http-lifecycle} {§splurnk-identity-oidc}
// Structured HTTP boundary error mapping cleanly to RFC 9457 Problem Details.

export const PROBLEM_TYPE_PREFIX = "https://problems.plurnk.xyz/splurnk";

export interface ProblemDetails {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly detail?: string;
    readonly retryable?: boolean;
}

export interface HttpErrorOptions extends ErrorOptions {
    readonly retryable?: boolean;
    readonly headers?: Readonly<Record<string, string>>;
}

export default class HttpError extends Error {
    readonly status: number;
    readonly problemSlug: string;
    readonly title: string;
    readonly retryable: boolean | undefined;
    readonly headers: Readonly<Record<string, string>>;

    constructor(
        status: number,
        problemSlug: string,
        title: string,
        detail: string,
        options: HttpErrorOptions = {},
    ) {
        const { retryable, headers = {}, ...errorOptions } = options;
        super(detail, errorOptions);
        this.name = "HttpError";
        this.status = status;
        this.problemSlug = problemSlug;
        this.title = title;
        this.retryable = retryable;
        this.headers = headers;
    }

    toProblem(): ProblemDetails {
        return {
            type: `${PROBLEM_TYPE_PREFIX}/${this.problemSlug}`,
            title: this.title,
            status: this.status,
            detail: this.message,
            ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
        };
    }
}

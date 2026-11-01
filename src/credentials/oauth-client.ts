// OAuth 2.0 client for QuickBooks authentication (Intuit's authorize and token endpoints)

import { randomBytes } from "node:crypto";
import type { QBCredentials } from "./types.js";

// Intuit's OAuth Playground redirect URL - works for both sandbox and production
const PLAYGROUND_REDIRECT_URL = "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl";

// Intuit OAuth 2.0 endpoints (the same for sandbox and production)
const AUTHORIZE_ENDPOINT = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// Required scopes for QuickBooks Online accounting access
const REQUIRED_SCOPES = ["com.intuit.quickbooks.accounting"];

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Get the environment setting (sandbox or production)
 */
function getEnvironment(): "sandbox" | "production" {
  return process.env.QBO_SANDBOX === "true" ? "sandbox" : "production";
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

/**
 * POST a grant to Intuit's token endpoint and return the new token pair
 */
async function requestTokens(
  clientId: string,
  clientSecret: string,
  grant: Record<string, string>
): Promise<TokenResponse> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(grant).toString(),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON body, reported below by status
  }

  if (!response.ok) {
    const error = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
    const description = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
    const tid = response.headers.get("intuit_tid");
    throw new Error(`Token request failed (${response.status}) ${error}${description}${tid ? ` (intuit_tid ${tid})` : ""}`);
  }

  if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
    throw new Error("Token response did not include access_token and refresh_token");
  }

  return { access_token: json.access_token, refresh_token: json.refresh_token };
}

/**
 * Generate the authorization URL for OAuth flow
 * User visits this URL to authorize the app
 */
export function generateAuthorizationUrl(clientId: string, _clientSecret: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: PLAYGROUND_REDIRECT_URL,
    response_type: "code",
    scope: REQUIRED_SCOPES.join(" "),
    state: randomBytes(18).toString("base64url"),
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/**
 * Result of exchanging an authorization code for tokens
 */
export interface TokenExchangeResult {
  credentials: QBCredentials;
  companyId: string;
}

/**
 * Exchange authorization code for access and refresh tokens
 */
export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  authorizationCode: string,
  realmId: string
): Promise<TokenExchangeResult> {
  const token = await requestTokens(clientId, clientSecret, {
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: PLAYGROUND_REDIRECT_URL,
  });

  const credentials: QBCredentials = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_url: PLAYGROUND_REDIRECT_URL,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    company_id: realmId,
  };

  return {
    credentials,
    companyId: realmId,
  };
}

/**
 * Refresh access token using a refresh token
 */
export async function refreshAccessToken(credentials: QBCredentials): Promise<QBCredentials> {
  const token = await requestTokens(credentials.client_id, credentials.client_secret, {
    grant_type: "refresh_token",
    refresh_token: credentials.refresh_token,
  });

  return {
    ...credentials,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  };
}

/**
 * Get instructions for the OAuth flow
 */
export function getOAuthInstructions(authUrl: string): string {
  const environment = getEnvironment();
  return `
## QuickBooks OAuth Setup

**Environment:** ${environment}

### Step 1: Authorize the Application

1. Open this URL in your browser:
   ${authUrl}

2. Sign in to your Intuit/QuickBooks account

3. Select the company you want to connect

4. Click "Connect" to authorize

### Step 2: Get the Authorization Code

After authorizing, you'll be redirected to the OAuth Playground.
The URL will contain two important values:

- **code**: The authorization code (a long string)
- **realmId**: Your company/realm ID (a number like 9130350484847232)

Example URL:
\`https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl?code=AB11...&realmId=9130350484847232\`

### Step 3: Complete Authentication

Call this tool again with:
- authorization_code: The "code" value from the URL
- realm_id: The "realmId" value from the URL

Example:
\`\`\`json
{
  "authorization_code": "AB11...",
  "realm_id": "9130350484847232"
}
\`\`\`
`.trim();
}

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Verifies a Firebase ID token for the WinnStorm project (winnstorm-43a69).
 *
 * Firebase ID tokens are RS256 JWTs signed by Google's secure-token service.
 * The public keys are published as a JWKS, which jose fetches and caches.
 * We require the correct issuer + audience so a token minted for any other
 * Firebase project is rejected.
 *
 * Lets the browser portal upload directly to cortex authenticated as the
 * signed-in WinnStorm user — no static secret in the client, no size limit.
 */
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "winnstorm-43a69";

const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  )
);

export interface FirebaseUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
}

export async function verifyFirebaseIdToken(
  token: string
): Promise<FirebaseUser | null> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    const p = payload as JWTPayload & {
      user_id?: string;
      email?: string;
      email_verified?: boolean;
    };
    const uid = p.sub || p.user_id;
    if (!uid) return null;
    return { uid, email: p.email, emailVerified: p.email_verified };
  } catch {
    return null;
  }
}

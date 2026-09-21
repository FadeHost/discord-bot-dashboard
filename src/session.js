// Logins, held in memory and pointed at by a signed cookie.
//
// Sessions are deliberately not written to disk: a restart signing everybody
// out costs two clicks, and nothing about a Discord login is worth keeping.

import crypto from "node:crypto";

import { sign, timingSafeEqual } from "./oauth.js";

export const COOKIE = "dash_sid";
const MAX_AGE_MS = 8 * 60 * 60 * 1000;

export class Sessions {
  /** @param {string} secret */
  constructor(secret) {
    this.secret = secret;
    this.byId = new Map();
  }

  /**
   * @param {{user: object, guilds: object[]}} data
   * @returns {string} the cookie value
   */
  create(data) {
    this.#sweep();

    const id = crypto.randomBytes(24).toString("base64url");
    this.byId.set(id, { ...data, expiresAt: Date.now() + MAX_AGE_MS });

    return `${id}.${sign(this.secret, id)}`;
  }

  /**
   * @param {string|undefined} cookieValue
   * @returns {object|null}
   */
  read(cookieValue) {
    if (typeof cookieValue !== "string" || !cookieValue.includes(".")) return null;

    const [id, signature] = cookieValue.split(".", 2);
    if (!timingSafeEqual(sign(this.secret, id), signature)) return null;

    const session = this.byId.get(id);
    if (!session) return null;

    if (session.expiresAt < Date.now()) {
      this.byId.delete(id);
      return null;
    }

    return session;
  }

  /** @param {string|undefined} cookieValue */
  destroy(cookieValue) {
    if (typeof cookieValue !== "string") return;
    this.byId.delete(cookieValue.split(".", 1)[0]);
  }

  /** A token tied to one session, checked on every form post. */
  csrf(cookieValue) {
    return sign(this.secret, `csrf:${cookieValue}`);
  }

  #sweep() {
    const now = Date.now();
    for (const [id, session] of this.byId) {
      if (session.expiresAt < now) this.byId.delete(id);
    }
  }
}

/** Put the session cookie on a response. */
export function setCookie(res, value, secure) {
  const parts = [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    // Lax, not Strict: the browser arrives here from Discord's consent page,
    // and a Strict cookie would not be sent on that navigation.
    "SameSite=Lax",
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * One cookie out of a Cookie header.
 *
 * @param {string|undefined} header
 * @param {string} name
 */
export function readCookie(header, name) {
  if (!header) return undefined;

  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }

  return undefined;
}

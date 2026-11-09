import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { chmod, readFile, writeFile } from 'fs/promises';

const COOKIE_NAME = 'motherHubSession';
const SESSION_DAYS = 30;

// Everything here can stop a game or open one to the internet, so every request but the login itself needs the
// password. It lives only as an argon2 hash, the signing secret only in the database, both made on first boot.
// The local token is for scripts on this machine (scripts/shelve.js): kept in a file only this user can read, and
// honored only from loopback, so it can't log in anything from across the network even if it were copied there
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

const localToken = async file => {
	if (!file) return null;

	const existing = (await readFile(file, 'utf8').catch(() => '')).trim();

	if (existing) return existing;

	const token = randomBytes(24).toString('base64url');

	await writeFile(file, `${token}\n`, { mode: 0o600 });
	await chmod(file, 0o600);

	return token;
};

export const createAuth = async ({ db, password, tokenFile }) => {
	const token = await localToken(tokenFile);
	const stored = (db.data.auth ||= {});

	stored.secret ||= randomBytes(32).toString('hex');

	if (password) stored.passwordHash = await Bun.password.hash(password);
	else if (!stored.passwordHash) {
		const generated = randomBytes(9).toString('base64url');

		stored.passwordHash = await Bun.password.hash(generated);

		console.log(
			`\n  Password: ${generated}\n  Set your own with --password or MOTHER_HUB_PASSWORD; this one is only printed once.\n`,
		);
	}

	await db.write();

	// Signed with the password hash mixed in, so changing the password logs every device out
	const sign = expiry => createHmac('sha256', stored.secret).update(`${expiry}.${stored.passwordHash}`).digest('hex');

	const verifyToken = token => {
		const [stamp, signature] = String(token || '').split('.');
		const expiry = Number(stamp);

		if (!signature || !Number.isFinite(expiry) || expiry < Date.now()) return false;

		const expected = Buffer.from(sign(expiry));
		const actual = Buffer.from(signature);

		return expected.length === actual.length && timingSafeEqual(expected, actual);
	};

	const readCookie = request => {
		for (const part of request.headers.get('cookie')?.split(';') ?? []) {
			const [name, ...value] = part.trim().split('=');

			if (name !== COOKIE_NAME) continue;

			try {
				return decodeURIComponent(value.join('='));
			} catch {
				return null;
			}
		}

		return null;
	};

	// SameSite=Strict keeps another site's fetch from riding along; Secure is left off, since this serves plain http
	// on the LAN
	const cookie = (value, maxAge) => `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

	return {
		isLoggedIn: (request, server) => {
			if (verifyToken(readCookie(request))) return true;

			const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];

			if (!token || !bearer || bearer.length !== token.length) return false;

			return (
				timingSafeEqual(Buffer.from(bearer), Buffer.from(token)) &&
				LOOPBACK.includes(server?.requestIP(request)?.address)
			);
		},
		checkPassword: async candidate => Bun.password.verify(String(candidate ?? ''), stored.passwordHash),
		sessionCookie: () => {
			const expiry = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;

			return cookie(`${expiry}.${sign(expiry)}`, SESSION_DAYS * 24 * 60 * 60);
		},
		clearedCookie: () => cookie('', 0),
	};
};

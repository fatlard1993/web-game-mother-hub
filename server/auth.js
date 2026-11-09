import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'motherHubSession';
const SESSION_DAYS = 30;

// The admin: whoever has the password (a session cookie) or the token (a bearer header). The password lives only as an
// argon2 hash, the signing secret only in the database, both made on first boot. The token is what paude hosts with,
// from this machine or another, and it is the whole admin, not only hosting: keep it as close as the password.
export const createAuth = async ({ db, password, token = null }) => {
	const stored = (db.data.auth ||= {});

	stored.secret ||= randomBytes(32).toString('hex');

	// Hashed again only when it's a new password: each hash is salted afresh, and sessions are signed with the hash, so
	// hashing the same password at every start would log every device out at every restart
	const unchanged = password && stored.passwordHash && (await Bun.password.verify(password, stored.passwordHash));

	if (password && !unchanged) stored.passwordHash = await Bun.password.hash(password);
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

	// SameSite=Strict keeps another site's fetch from riding along; Secure, when the page came over https (hub.home,
	// through Caddy), keeps the browser from ever sending it in the clear
	const cookie = (value, maxAge, secure) =>
		`${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

	// Compared as digests, so neither the token's length nor its bytes show in how long a wrong one takes
	const digest = text => createHash('sha256').update(String(text)).digest();

	return {
		isLoggedIn: request => {
			if (verifyToken(readCookie(request))) return true;

			const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];

			return !!token && !!bearer && timingSafeEqual(digest(bearer), digest(token));
		},
		checkPassword: async candidate => Bun.password.verify(String(candidate ?? ''), stored.passwordHash),
		sessionCookie: ({ secure = false } = {}) => {
			const expiry = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;

			return cookie(`${expiry}.${sign(expiry)}`, SESSION_DAYS * 24 * 60 * 60, secure);
		},
		clearedCookie: ({ secure = false } = {}) => cookie('', 0, secure),
	};
};

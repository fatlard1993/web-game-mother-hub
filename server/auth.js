import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'motherHubSession';
const SESSION_DAYS = 30;

// Everything here can stop a game or open one to the internet, so every request but the login itself needs the
// password. It lives only as an argon2 hash, the signing secret only in the database, both made on first boot.
export const createAuth = async ({ db, password }) => {
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
		isLoggedIn: request => verifyToken(readCookie(request)),
		checkPassword: async candidate => Bun.password.verify(String(candidate ?? ''), stored.passwordHash),
		sessionCookie: () => {
			const expiry = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;

			return cookie(`${expiry}.${sign(expiry)}`, SESSION_DAYS * 24 * 60 * 60);
		},
		clearedCookie: () => cookie('', 0),
	};
};

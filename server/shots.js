import { existsSync } from 'fs';
import { mkdir, mkdtemp, rename, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

// Pictures of the games as they are now, taken by the hub with headless Chrome: a game whose README shows nothing
// still gets a cover, and every game's gallery has a picture as fresh as its last start. Chrome is found on the PATH,
// or named by CHROME; without one there are simply no live pictures.

const CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const WIDTH = 1280;
const HEIGHT = 720;
const TIMEOUT_MS = 30_000;
// Time for the page's scripts to draw before the picture is taken
const DRAW_BUDGET_MS = 4000;

export const findChrome = () => process.env.CHROME || CANDIDATES.map(name => Bun.which(name)).find(Boolean) || null;

export const createShots = ({ dir, chrome = findChrome(), run }) => {
	const file = id => path.join(dir, `${id}.png`);

	return {
		available: !!chrome,

		file: id => (existsSync(file(id)) ? file(id) : null),

		// Written beside its place and moved in, so a half-written picture is never served
		take: async (id, url) => {
			if (!chrome) return false;

			await mkdir(dir, { recursive: true });

			const profile = await mkdtemp(path.join(os.tmpdir(), 'mother-hub-chrome-'));
			const pending = path.join(dir, `.${id}.png`);

			try {
				const { code } = await run(
					[
						chrome,
						'--headless=new',
						'--disable-gpu',
						'--hide-scrollbars',
						'--no-first-run',
						'--no-default-browser-check',
						'--mute-audio',
						`--user-data-dir=${profile}`,
						`--window-size=${WIDTH},${HEIGHT}`,
						`--virtual-time-budget=${DRAW_BUDGET_MS}`,
						`--timeout=${TIMEOUT_MS}`,
						`--screenshot=${pending}`,
						url,
					],
					{},
				);

				if (code !== 0 || !existsSync(pending)) return false;

				await rename(pending, file(id));

				return true;
			} finally {
				await rm(profile, { recursive: true, force: true });
				await rm(pending, { force: true });
			}
		},

		forget: id => rm(file(id), { force: true }),
	};
};

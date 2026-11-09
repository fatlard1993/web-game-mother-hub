import { realpathSync } from 'fs';
import path from 'path';

// A file a game names (its README, icon, pictures) is served to anyone on the LAN, so it must really be inside the
// game's folder: its real path, links followed, not just its spelling. Returns that real path, or null.
export const realWithin = (root, file) => {
	try {
		const realRoot = realpathSync(root);
		const realFile = realpathSync(file);

		return realFile.startsWith(realRoot + path.sep) ? realFile : null;
	} catch {
		return null;
	}
};

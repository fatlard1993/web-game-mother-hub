import { Page } from '@vanilla-bean/components';

import { getSession } from './api';
import Hub from './Hub';

import '@vanilla-bean/components/app/reloadOnBuild';

const page = new Page({ appendTo: document.body });

// Anyone on the LAN finds and plays the games; logging in (the corner button) makes this page the admin's, to run them
const show = async () => {
	const admin = await getSession().catch(() => false);

	page.empty();
	new Hub({ appendTo: page, admin, onSessionChanged: show });
};

show();

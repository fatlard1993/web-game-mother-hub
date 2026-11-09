import { Page } from '@vanilla-bean/components';

import { getSession } from './api';
import { loginDialog } from './dialogs';
import Hub from './Hub';

import '@vanilla-bean/components/app/reloadOnBuild';

const page = new Page({ appendTo: document.body });

const showHub = () => {
	page.empty();
	new Hub({ appendTo: page, onLoggedOut: showLogin });
};

const showLogin = () => {
	page.empty();
	loginDialog(showHub);
};

(await getSession().catch(() => false)) ? showHub() : showLogin();

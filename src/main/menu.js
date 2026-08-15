/* Application menu. Rebuilt whenever the campaign changes so the recent list
 * stays honest. */

const { Menu, shell, app, dialog } = require('electron');
const path = require('path');
const { loadConfig, forgetVault } = require('./store');

function buildMenu(ctx) {
  const config = loadConfig();
  const isMac = process.platform === 'darwin';

  const recent = config.vaults
    .filter(v => !ctx.vault || path.resolve(v.path) !== path.resolve(ctx.vault.root))
    .slice(0, 8)
    .map(v => ({
      label: v.title || path.basename(v.path),
      sublabel: v.path,
      click: () => {
        const result = ctx.openVault(v.path);
        if (!result.ok) {
          dialog.showMessageBox(ctx.win, {
            type: 'warning',
            message: `Could not open ${v.title || v.path}`,
            detail: `${result.error}\n\nIt has been removed from the recent list.`,
          });
          forgetVault(v.path);
          buildMenu(ctx);
        }
      },
    }));

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Campaign',
      submenu: [
        {
          label: 'New Campaign…',
          accelerator: 'CmdOrCtrl+N',
          click: () => ctx.win && ctx.win.webContents.send('menu:new-campaign'),
        },
        {
          label: 'Open Campaign Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => ctx.chooseVault(),
        },
        {
          label: 'Open Recent',
          enabled: recent.length > 0,
          submenu: recent.length ? recent : [{ label: 'Nothing yet', enabled: false }],
        },
        { type: 'separator' },
        {
          label: 'Reveal Campaign Folder',
          enabled: !!ctx.vault,
          click: () => ctx.vault && shell.openPath(ctx.vault.root),
        },
        {
          label: 'Campaign Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => ctx.win && ctx.win.webContents.send('menu:campaign-settings'),
        },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [{ role: 'quit' }]),
      ],
    },
    {
      label: 'Add',
      submenu: [
        { label: 'Location…', accelerator: 'CmdOrCtrl+Shift+L', click: () => send(ctx, 'menu:add', 'location') },
        { label: 'Person or Thing…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send(ctx, 'menu:add', 'entity') },
        { label: 'Event…', accelerator: 'CmdOrCtrl+Shift+T', click: () => send(ctx, 'menu:add', 'event') },
        { label: 'Note…', accelerator: 'CmdOrCtrl+Shift+N', click: () => send(ctx, 'menu:add', 'note') },
        { type: 'separator' },
        { label: 'Import from PDF or Notes…', click: () => send(ctx, 'menu:import') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Assistant', accelerator: 'CmdOrCtrl+J', click: () => send(ctx, 'menu:toggle-assistant') },
        { label: 'Search', accelerator: 'CmdOrCtrl+K', click: () => send(ctx, 'menu:search') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: `About ${ctx.product}`,
          click: () => dialog.showMessageBox(ctx.win, {
            type: 'info',
            message: ctx.product,
            detail: `Version ${app.getVersion()}\n\nA table-agnostic screen for running any tabletop campaign.`,
          }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function send(ctx, channel, payload) {
  if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(channel, payload);
}

module.exports = { buildMenu };

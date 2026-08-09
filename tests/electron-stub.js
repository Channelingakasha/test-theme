/* Minimal electron stand-in so the install pipeline can run under plain node. */
exports.app = {
  getPath: () => process.env.PALMOD_TEST_USERDATA
}
exports.net = {
  fetch: async () => {
    throw new Error('network disabled in tests')
  }
}
exports.shell = { openPath: async () => '', showItemInFolder: () => {}, openExternal: async () => {} }
exports.ipcMain = { handle: () => {} }
exports.dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
exports.BrowserWindow = class {}
exports.protocol = { registerSchemesAsPrivileged: () => {}, handle: () => {} }

// Renders build/icon.svg to the 1024px build/icon.png electron-builder makes each platform's icon from.
// Run with `npm run icon` after changing the SVG, and commit both.
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

const size = 1024
const svgFile = join(__dirname, '..', 'build', 'icon.svg')
const pngFile = join(__dirname, '..', 'build', 'icon.png')

// Drawn onto a canvas of exactly `size` pixels, whatever the display's scaling.
const draw = (svgUrl) => `new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = ${size}
    canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size})
    resolve(canvas.toDataURL('image/png'))
  }
  image.onerror = () => reject(new Error('The SVG could not be drawn'))
  image.src = ${JSON.stringify(svgUrl)}
})`

void app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ show: false })
    await window.loadURL('about:blank')
    const svgUrl = `data:image/svg+xml;base64,${readFileSync(svgFile).toString('base64')}`
    const pngUrl = await window.webContents.executeJavaScript(draw(svgUrl))
    writeFileSync(pngFile, Buffer.from(pngUrl.slice(pngUrl.indexOf(',') + 1), 'base64'))
    app.quit()
  })
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`)
    app.exit(1)
  })

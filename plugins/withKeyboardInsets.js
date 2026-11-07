const { withMainActivity } = require("@expo/config-plugins")

const imports = `import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
`

const listener = `
    val root = findViewById<View>(android.R.id.content)
    val bottom = root.paddingBottom
    // Expo SDK 54 apps are edge-to-edge on every Android version, so the IME
    // no longer resizes the window (adjustResize is a no-op). Pad the content
    // view with the IME inset on ALL API levels, not just 35+: on older
    // devices (e.g. Android 10) the keyboard otherwise covers the composer.
    // Inset is 0 whenever the window is already resized, so this stays safe
    // on configurations where the window does resize.
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, bottom + insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
      insets
    }
    ViewCompat.requestApplyInsets(root)
`

function addKeyboardInsets(contents) {
  if (contents.includes("WindowInsetsCompat.Type.ime()")) return contents
  if (!contents.includes("import android.os.Bundle\n") || !contents.includes("    super.onCreate(null)\n")) {
    throw new Error("Unsupported MainActivity.kt template")
  }
  return contents
    .replace("import android.os.Bundle\n", `import android.os.Bundle\n${imports}`)
    .replace("    super.onCreate(null)\n", `    super.onCreate(null)\n${listener}`)
}

module.exports = (config) =>
  withMainActivity(config, (config) => {
    if (config.modResults.language !== "kt") throw new Error("Keyboard inset fix requires MainActivity.kt")
    config.modResults.contents = addKeyboardInsets(config.modResults.contents)
    return config
  })

module.exports.addKeyboardInsets = addKeyboardInsets

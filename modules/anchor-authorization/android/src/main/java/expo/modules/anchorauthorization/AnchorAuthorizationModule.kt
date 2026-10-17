package expo.modules.anchorauthorization

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ResultReceiver
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AnchorAuthorizationModule : Module() {
  private var activeToken: String? = null

  override fun definition() = ModuleDefinition {
    Name("AnchorAuthorization")

    AsyncFunction("start") { token: String, title: String, body: String, promise: Promise ->
      val context = appContext.reactContext ?: throw IllegalStateException("Wallet is unavailable")
      check(appContext.currentActivity != null) { "Start authorization from the wallet" }
      activeToken = token
      val ready = object : ResultReceiver(Handler(Looper.getMainLooper())) {
        override fun onReceiveResult(code: Int, data: Bundle?) {
          if (code == Activity.RESULT_OK) promise.resolve(null)
          else promise.reject("ERR_ANCHOR_AUTHORIZATION", "Unable to keep authorization connected", null)
        }
      }
      val intent = Intent(context, AnchorAuthorizationService::class.java)
        .putExtra("token", token).putExtra("title", title).putExtra("body", body).putExtra("ready", ready)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
      else context.startService(intent)
    }

    AsyncFunction("stop") { token: String ->
      AnchorAuthorizationService.stop(token)
      if (activeToken == token) activeToken = null
    }

    OnDestroy { activeToken?.let { AnchorAuthorizationService.stop(it) }; activeToken = null }
  }
}

package expo.modules.anchorauthorization

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ResultReceiver
import android.util.Log
import java.lang.ref.WeakReference

/** Keeps only the user-initiated callback connection online; never holds wallet keys. */
class AnchorAuthorizationService : Service() {
  companion object {
    private const val CHANNEL = "anchor-authorization"
    private const val NOTIFICATION = 8321
    private var instance: WeakReference<AnchorAuthorizationService>? = null

    fun stop(token: String) {
      instance?.get()?.let { service ->
        service.handler.post { if (service.token == token) service.stopSelf() }
      }
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private var token: String? = null
  private val expire = Runnable { stopSelf() }

  override fun onCreate() { super.onCreate(); instance = WeakReference(this) }
  override fun onBind(intent: Intent?): IBinder? = null

  @Suppress("DEPRECATION")
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val ready = intent?.getParcelableExtra<ResultReceiver>("ready")
    token = intent?.getStringExtra("token")
    if (token == null) { stopSelf(); return START_NOT_STICKY }
    try {
      val title = intent?.getStringExtra("title") ?: "Anchor authorization"
      val body = intent?.getStringExtra("body") ?: "Waiting for Anchor authorization"
      if (Build.VERSION.SDK_INT >= 26) {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
          NotificationChannel(CHANNEL, title, NotificationManager.IMPORTANCE_LOW)
        )
      }
      val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
      builder.setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle(title).setContentText(body)
        .setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_STATUS)
      packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
        launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      }
      if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else startForeground(NOTIFICATION, builder.build())
      Log.i("AnchorAuthorization", "Callback task started")
      handler.removeCallbacks(expire)
      // Native deadline also works if RN timers are paused or the bridge disappears.
      handler.postDelayed(expire, 310_000L)
      ready?.send(Activity.RESULT_OK, null)
    } catch (error: Exception) {
      Log.w("AnchorAuthorization", "Callback task unavailable: ${error.javaClass.simpleName}")
      ready?.send(Activity.RESULT_CANCELED, null)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) { stopSelf() }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    if (instance?.get() === this) instance = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    Log.i("AnchorAuthorization", "Callback task stopped")
    super.onDestroy()
  }
}

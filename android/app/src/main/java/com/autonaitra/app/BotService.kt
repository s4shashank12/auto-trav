package com.autonaitra.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.text.DateFormat
import java.time.Instant
import java.util.Date

/**
 * Keeps the bot running: a foreground service (with its notification) that hosts the engine.
 * While any account runs, a partial wake lock keeps the CPU awake so rounds happen on time with
 * the screen off; with nothing running and no screen of the app open, the service stops.
 */
class BotService : Service(), BotEngine.Listener {

    companion object {
        private const val TAG = "auto-naitra"
        private const val CHANNEL = "bot"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP_ALL = "com.autonaitra.app.STOP_ALL"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, BotService::class.java))
        }
    }

    inner class LocalBinder : Binder() {
        val service: BotService get() = this@BotService
    }

    private data class Account(val name: String, val status: String, val nextRunAt: String?)

    private val binder = LocalBinder()
    private var clients = 0
    private var running = 0
    private var busy = 0
    private var accounts: List<Account> = emptyList()
    private var wakeLock: PowerManager.WakeLock? = null

    lateinit var engine: BotEngine
        private set

    /** The open screen's answer handler, if a screen is open. */
    var apiListener: ((Int, Int, String) -> Unit)? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        goForeground()
        engine = BotEngine(this, this)
        engine.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground()
        if (intent?.action == ACTION_STOP_ALL) engine.stopAll()
        return START_STICKY
    }

    override fun onBind(intent: Intent): IBinder {
        clients += 1
        return binder
    }

    override fun onRebind(intent: Intent) {
        clients += 1
    }

    override fun onUnbind(intent: Intent): Boolean {
        clients = (clients - 1).coerceAtLeast(0)
        apiListener = null
        stopIfIdle()
        return true
    }

    override fun onDestroy() {
        engine.destroy()
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onEngineReady() {
        Log.i(TAG, "engine ready")
    }

    override fun onEngineStatus(json: String) {
        val status = JSONObject(json)
        running = status.optInt("running")
        busy = status.optInt("busy", running)
        val list = status.optJSONArray("accounts")
        accounts = (0 until (list?.length() ?: 0)).map { i ->
            val a = list!!.getJSONObject(i)
            Account(a.optString("name"), a.optString("status"), a.optString("nextRunAt").takeIf { it.isNotEmpty() && it != "null" })
        }
        if (busy > 0) acquireWakeLock() else releaseWakeLock()
        notifyStatus()
        stopIfIdle()
    }

    override fun onApiResponse(requestId: Int, status: Int, body: String) {
        apiListener?.invoke(requestId, status, body)
    }

    private fun stopIfIdle() {
        if (clients > 0 || busy > 0 || !engine.ready) return
        Log.i(TAG, "nothing running and no screen open: stopping the service")
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "auto-naitra:bot").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
            description = getString(R.string.channel_description)
            setShowBadge(false)
        }
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
    }

    private fun goForeground() {
        try {
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
        } catch (e: Exception) {
            // Android refuses a foreground start from the background (e.g. a sticky restart on
            // some versions): the engine still runs until the app is opened again.
            Log.w(TAG, "cannot go foreground: ${e.message}")
        }
    }

    private fun notifyStatus() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        try {
            nm.notify(NOTIFICATION_ID, buildNotification())
        } catch (e: SecurityException) {
            Log.w(TAG, "notification not shown: ${e.message}")
        }
    }

    private fun describe(a: Account): String {
        val time = a.nextRunAt?.let {
            try {
                DateFormat.getTimeInstance(DateFormat.SHORT).format(Date.from(Instant.parse(it)))
            } catch (e: Exception) {
                null
            }
        }
        return when {
            a.status == "running" -> "${a.name}: playing a round"
            a.status == "sleeping" && time != null -> "${a.name}: next round at $time"
            a.status == "error" && time != null -> "${a.name}: error, retrying at $time"
            else -> "${a.name}: ${a.status}"
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val title = when (running) {
            0 -> getString(R.string.notif_idle)
            1 -> "1 account running"
            else -> "$running accounts running"
        }
        val lines = accounts.map(::describe)
        val builder = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(lines.firstOrNull() ?: "Open the app to start an account.")
            .setStyle(NotificationCompat.BigTextStyle().bigText(lines.joinToString("\n").ifEmpty { "Open the app to start an account." }))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setColor(ContextCompat.getColor(this, R.color.brand))
        if (running > 0) {
            val stop = PendingIntent.getService(
                this, 1, Intent(this, BotService::class.java).setAction(ACTION_STOP_ALL),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.addAction(0, getString(R.string.notif_stop_all), stop)
        }
        return builder.build()
    }
}

package com.autonaitra.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * After the phone restarts (or the app is updated), starts the service again if any account was
 * running; the engine then starts those accounts by itself.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!BotDatabase.get(context).hasEnabledServers()) return
        try {
            BotService.start(context)
        } catch (e: Exception) {
            Log.w("auto-naitra", "could not start the bot after ${intent.action}: ${e.message}")
        }
    }
}

package com.autonaitra.app

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.database.sqlite.SQLiteProgram
import android.database.sqlite.SQLiteStatement
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/**
 * The app's SQLite database. Its tables belong to the bot engine, which creates and migrates them
 * (engine/src/repo.js); this class only runs the engine's statements, with typed parameters, and
 * returns rows as JSON.
 */
class BotDatabase private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, NAME, null, 1) {

    companion object {
        const val NAME = "auto-naitra.db"

        @Volatile
        private var instance: BotDatabase? = null

        fun get(context: Context): BotDatabase =
            instance ?: synchronized(this) { instance ?: BotDatabase(context).also { instance = it } }
    }

    override fun onConfigure(db: SQLiteDatabase) {
        db.setForeignKeyConstraintsEnabled(true)
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) = Unit

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    /** Rows of a SELECT as a JSON array of objects. */
    fun query(sql: String, params: JSONArray): String {
        val cursor = readableDatabase.rawQueryWithFactory({ _, driver, table, query ->
            bind(query, params)
            SQLiteCursor(driver, table, query)
        }, sql, emptyArray(), "")
        cursor.use { c ->
            val out = JSONArray()
            val names = c.columnNames
            while (c.moveToNext()) {
                val row = JSONObject()
                for (i in names.indices) {
                    row.put(names[i], when (c.getType(i)) {
                        Cursor.FIELD_TYPE_NULL -> JSONObject.NULL
                        Cursor.FIELD_TYPE_INTEGER -> c.getLong(i)
                        Cursor.FIELD_TYPE_FLOAT -> c.getDouble(i)
                        Cursor.FIELD_TYPE_BLOB -> Base64.encodeToString(c.getBlob(i), Base64.NO_WRAP)
                        else -> c.getString(i)
                    })
                }
                out.put(row)
            }
            return out.toString()
        }
    }

    /** One statement; returns { changes, lastId }. */
    fun run(sql: String, params: JSONArray): String {
        writableDatabase.compileStatement(sql).use { st ->
            bind(st, params)
            return execute(st, sql).toString()
        }
    }

    /** Statements in one transaction: [{ sql, params? , rows? }], `rows` running it once per row. */
    fun batch(statements: JSONArray): String {
        val db = writableDatabase
        var changes = 0
        db.beginTransaction()
        try {
            for (i in 0 until statements.length()) {
                val s = statements.getJSONObject(i)
                val sql = s.getString("sql")
                val rows = s.optJSONArray("rows")
                db.compileStatement(sql).use { st ->
                    if (rows != null) {
                        for (r in 0 until rows.length()) {
                            st.clearBindings()
                            bind(st, rows.getJSONArray(r))
                            changes += execute(st, sql).getInt("changes")
                        }
                    } else {
                        s.optJSONArray("params")?.let { bind(st, it) }
                        changes += execute(st, sql).getInt("changes")
                    }
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return JSONObject().put("changes", changes).toString()
    }

    private fun execute(st: SQLiteStatement, sql: String): JSONObject {
        val verb = sql.trimStart().take(7).lowercase()
        return when {
            verb.startsWith("insert") || verb.startsWith("replace") -> {
                val id = st.executeInsert()
                JSONObject().put("changes", if (id >= 0) 1 else 0).put("lastId", id)
            }
            verb.startsWith("update") || verb.startsWith("delete") ->
                JSONObject().put("changes", st.executeUpdateDelete()).put("lastId", JSONObject.NULL)
            else -> {
                st.execute()
                JSONObject().put("changes", 0).put("lastId", JSONObject.NULL)
            }
        }
    }

    private fun bind(program: SQLiteProgram, params: JSONArray) {
        for (i in 0 until params.length()) {
            val index = i + 1
            when (val v = params.opt(i)) {
                null, JSONObject.NULL -> program.bindNull(index)
                is Boolean -> program.bindLong(index, if (v) 1 else 0)
                is Int -> program.bindLong(index, v.toLong())
                is Long -> program.bindLong(index, v)
                is Double -> if (v % 1.0 == 0.0 && v >= Long.MIN_VALUE && v <= Long.MAX_VALUE) {
                    program.bindLong(index, v.toLong())
                } else {
                    program.bindDouble(index, v)
                }
                is Number -> program.bindDouble(index, v.toDouble())
                else -> program.bindString(index, v.toString())
            }
        }
    }

    /** Whether any account is set to run (for starting the service after a reboot). */
    fun hasEnabledServers(): Boolean = try {
        readableDatabase.rawQuery("select count(*) from servers where enabled = 1", null).use {
            it.moveToFirst() && it.getInt(0) > 0
        }
    } catch (e: Exception) {
        false // no tables yet: the engine has never run
    }
}

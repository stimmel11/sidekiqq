package com.sidekiqq.phone.medallion

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothStatusCodes
import android.os.Build
import android.os.Handler
import android.util.Log
import java.util.ArrayDeque

/**
 * Android allows only ONE outstanding GATT operation per connection. This serializes them.
 * Callers invoke [completed] from the matching BluetoothGattCallback method.
 * All methods must be called on [handler]'s thread.
 */
@SuppressLint("MissingPermission") // BLUETOOTH_CONNECT is checked before MedallionService connects
internal class GattQueue(private val handler: Handler) {

    sealed interface Op {
        data class Write(val ch: BluetoothGattCharacteristic, val value: ByteArray, val withResponse: Boolean) : Op
        data class WriteDescriptor(val d: BluetoothGattDescriptor, val value: ByteArray) : Op
        data class Read(val ch: BluetoothGattCharacteristic) : Op
        data class RequestMtu(val mtu: Int) : Op
    }

    private val ops = ArrayDeque<Op>()
    private var busy = false
    private var gatt: BluetoothGatt? = null
    private val timeout = Runnable {
        Log.w(TAG, "GATT op timed out; moving on")
        completed()
    }

    fun attach(g: BluetoothGatt) { gatt = g; ops.clear(); busy = false }
    fun detach() { gatt = null; ops.clear(); busy = false; handler.removeCallbacks(timeout) }

    fun enqueue(op: Op) {
        ops.addLast(op)
        if (!busy) next()
    }

    fun completed() {
        handler.removeCallbacks(timeout)
        busy = false
        next()
    }

    private fun next() {
        val g = gatt ?: return
        val op = ops.pollFirst() ?: return
        busy = true
        handler.postDelayed(timeout, OP_TIMEOUT_MS)
        val started = try { start(g, op) } catch (e: SecurityException) { Log.e(TAG, "permission", e); false }
        if (!started) {
            Log.w(TAG, "GATT op failed to start: $op")
            completed()
        }
    }

    @Suppress("DEPRECATION")
    private fun start(g: BluetoothGatt, op: Op): Boolean = when (op) {
        is Op.RequestMtu -> g.requestMtu(op.mtu)
        is Op.Read -> g.readCharacteristic(op.ch)
        is Op.Write -> {
            val type = if (op.withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                       else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(op.ch, op.value, type) == BluetoothStatusCodes.SUCCESS
            } else {
                op.ch.writeType = type
                op.ch.value = op.value
                g.writeCharacteristic(op.ch)
            }
        }
        is Op.WriteDescriptor -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(op.d, op.value) == BluetoothStatusCodes.SUCCESS
            } else {
                op.d.value = op.value
                g.writeDescriptor(op.d)
            }
        }
    }

    private companion object {
        const val TAG = "SideKiqqGatt"
        const val OP_TIMEOUT_MS = 5_000L
    }
}

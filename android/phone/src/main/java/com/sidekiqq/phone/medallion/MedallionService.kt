package com.sidekiqq.phone.medallion

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.ParcelUuid
import android.util.Log
import androidx.core.content.ContextCompat
import com.sidekiqq.phone.MainActivity
import com.sidekiqq.phone.R
import com.sidekiqq.phone.SideKiqqApp
import com.sidekiqq.phone.assistant.VoiceAssistant
import com.sidekiqq.phone.assistant.VoiceOutput
import com.sidekiqq.phone.sideKiqqApp
import com.sidekiqq.shared.model.Device
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Observable medallion link state (UI reads this). */
data class MedallionState(
    val running: Boolean = false,
    val phase: Phase = Phase.IDLE,
    val deviceName: String? = null,
    val battery: Int? = null,
    val lastTranscript: String? = null,
    val lastReply: String? = null,
    val lastAudioWarning: String? = null,
) {
    enum class Phase { IDLE, SCANNING, CONNECTING, CONNECTED, LISTENING, THINKING, SPEAKING }
}

/**
 * Foreground service relaying the SideKiqq medallion (BLE) to the brain.
 *
 * Flow: scan for SERVICE -> connect -> MTU 247 -> enable notify on AUDIO, CONTROL, BATTERY ->
 * CONTROL 0x01 starts an utterance, AUDIO packets are reassembled, CONTROL 0x02 ends it ->
 * WAV -> /api/transcribe -> /api/ask(device = medallion), with CONTROL 0x10 written while thinking ->
 * speak `spoken` on the active audio route (glasses / earbuds) -> CONTROL 0x11 -> reply text to the watch.
 *
 * Plain android.bluetooth APIs, no Nordic library. GATT callbacks are moved onto [bleThread].
 */
@SuppressLint("MissingPermission") // runtime permissions are checked in hasBlePermissions() before any BLE call
class MedallionService : Service() {

    private val bleThread = HandlerThread("medallion-ble").apply { start() }
    private val ble = Handler(bleThread.looper)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val queue = GattQueue(ble)
    private val assembler = UtteranceAssembler()
    private val utterances = Channel<UtteranceAssembler.Utterance>(capacity = 2)

    private var gatt: BluetoothGatt? = null
    private var controlChar: BluetoothGattCharacteristic? = null
    private var scanning = false
    private var stopping = false
    private var reconnectDelayMs = INITIAL_RECONNECT_MS

    private lateinit var assistant: VoiceAssistant

    private val utteranceTimeout = Runnable {
        Log.w(TAG, "No END-of-utterance within ${UTTERANCE_IDLE_MS} ms; finalizing")
        finishUtterance()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val app = sideKiqqApp
        assistant = VoiceAssistant(app::client, app.wearRelay)
        scope.launch { for (u in utterances) process(u) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            return START_NOT_STICKY
        }
        // connectedDevice FGS type requires BLUETOOTH_CONNECT at runtime; startForeground throws without it.
        try {
            startInForeground()
        } catch (e: Exception) {
            Log.e(TAG, "Cannot start medallion foreground service", e)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!hasBlePermissions(this)) {
            Log.e(TAG, "Missing Bluetooth permissions; stopping")
            shutdown()
            return START_NOT_STICKY
        }
        instance = this
        _state.update { it.copy(running = true) }
        ble.post { if (gatt == null && !scanning) startScan() }
        return START_STICKY
    }

    override fun onDestroy() {
        stopping = true
        instance = null
        ble.post {
            stopScan()
            gatt?.close()
            gatt = null
            queue.detach()
        }
        bleThread.quitSafely()
        scope.cancel()
        _state.value = MedallionState()
        super.onDestroy()
    }

    private fun shutdown() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ------------------------------------------------------------ foreground notification

    private fun startInForeground() {
        val n = buildNotification("Looking for your medallion…")
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
        startForeground(NOTIFICATION_ID, n, type)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, MedallionService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, SideKiqqApp.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_sidekiqq)
            .setContentTitle("SideKiqq medallion")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Disconnect", stop).build())
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(android.app.NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(text))
    }

    // ------------------------------------------------------------ scanning

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            ble.post {
                if (gatt != null) return@post
                stopScan()
                connect(result.device, autoConnect = false)
            }
        }

        override fun onScanFailed(errorCode: Int) {
            Log.e(TAG, "BLE scan failed: $errorCode")
            ble.post { scanning = false; scheduleReconnect(null) }
        }
    }

    private fun startScan() {
        val scanner = getSystemService(BluetoothManager::class.java)?.adapter?.bluetoothLeScanner
        if (scanner == null) {
            Log.w(TAG, "Bluetooth off or unavailable; retrying")
            scheduleReconnect(null)
            return
        }
        val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(MedallionProtocol.SERVICE)).build())
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .build()
        scanner.startScan(filters, settings, scanCallback)
        scanning = true
        setPhase(MedallionState.Phase.SCANNING)
        updateNotification("Looking for your medallion…")
        // Don't scan forever at LOW_LATENCY; back off and retry.
        ble.postDelayed({ if (scanning) { stopScan(); scheduleReconnect(null) } }, SCAN_WINDOW_MS)
    }

    private fun stopScan() {
        if (!scanning) return
        scanning = false
        runCatching {
            getSystemService(BluetoothManager::class.java)?.adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        }
    }

    // ------------------------------------------------------------ connection

    private fun connect(device: BluetoothDevice, autoConnect: Boolean) {
        setPhase(MedallionState.Phase.CONNECTING)
        _state.update { it.copy(deviceName = device.name ?: device.address) }
        gatt = device.connectGatt(this, autoConnect, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    /** After a drop: reconnect directly to the known device (autoConnect), otherwise rescan. */
    private fun scheduleReconnect(device: BluetoothDevice?) {
        if (stopping) return
        val delay = reconnectDelayMs
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(MAX_RECONNECT_MS)
        ble.postDelayed({
            if (stopping || gatt != null) return@postDelayed
            if (device != null) connect(device, autoConnect = true) else startScan()
        }, delay)
    }

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) = ble.post {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                Log.i(TAG, "Connected to ${g.device.address}")
                reconnectDelayMs = INITIAL_RECONNECT_MS
                queue.attach(g)
                g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                queue.enqueue(GattQueue.Op.RequestMtu(MedallionProtocol.DESIRED_MTU))
                // Service discovery is not a queued op; it's kicked off after MTU (see onMtuChanged).
            } else {
                Log.i(TAG, "Disconnected (status=$status state=$newState)")
                val dev = g.device
                queue.detach()
                g.close()
                if (gatt === g) gatt = null
                controlChar = null
                if (assembler.isActive) assembler.cancel()
                ble.removeCallbacks(utteranceTimeout)
                setPhase(MedallionState.Phase.IDLE)
                _state.update { it.copy(battery = null) }
                updateNotification("Medallion disconnected — reconnecting…")
                scheduleReconnect(dev)
            }
        }.let { }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) = ble.post {
            Log.i(TAG, "MTU=$mtu status=$status")
            queue.completed()
            if (!g.discoverServices()) Log.e(TAG, "discoverServices failed to start")
        }.let { }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) = ble.post {
            val svc = g.getService(MedallionProtocol.SERVICE)
            if (status != BluetoothGatt.GATT_SUCCESS || svc == null) {
                Log.e(TAG, "SideKiqq service not found (status=$status)")
                g.disconnect()
                return@post
            }
            val audio = svc.getCharacteristic(MedallionProtocol.AUDIO)
            val control = svc.getCharacteristic(MedallionProtocol.CONTROL)
            val battery = svc.getCharacteristic(MedallionProtocol.BATTERY)
            controlChar = control
            listOfNotNull(control, audio, battery).forEach { enableNotify(g, it) }
            battery?.let { queue.enqueue(GattQueue.Op.Read(it)) }
            setPhase(MedallionState.Phase.CONNECTED)
            updateNotification("Medallion connected")
        }.let { }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) =
            ble.post { queue.completed() }.let { }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) =
            ble.post { queue.completed() }.let { }

        // API 33+ delivers the value directly.
        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            ble.post {
                if (status == BluetoothGatt.GATT_SUCCESS) onValue(c.uuid, value)
                queue.completed()
            }
        }

        @Deprecated("Deprecated in Java")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return // handled above
            val v = c.value?.copyOf() ?: ByteArray(0)
            ble.post {
                if (status == BluetoothGatt.GATT_SUCCESS) onValue(c.uuid, v)
                queue.completed()
            }
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            val copy = value.copyOf()
            ble.post { onValue(c.uuid, copy) }
        }

        @Deprecated("Deprecated in Java")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            // On API 33+ the framework calls both overloads; only handle the legacy one on older releases.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            val copy = c.value?.copyOf() ?: return
            ble.post { onValue(c.uuid, copy) }
        }
    }

    private fun enableNotify(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
        if (!g.setCharacteristicNotification(c, true)) {
            Log.w(TAG, "setCharacteristicNotification failed for ${c.uuid}")
        }
        val cccd = c.getDescriptor(MedallionProtocol.CCCD) ?: return
        queue.enqueue(GattQueue.Op.WriteDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE))
    }

    // ------------------------------------------------------------ protocol handling (ble thread)

    private fun onValue(uuid: java.util.UUID, value: ByteArray) {
        when (uuid) {
            MedallionProtocol.AUDIO -> onAudio(value)
            MedallionProtocol.CONTROL -> value.firstOrNull()?.let { onControl(it) }
            MedallionProtocol.BATTERY -> value.firstOrNull()?.let { b ->
                _state.update { it.copy(battery = (b.toInt() and 0xFF).coerceAtMost(100)) }
            }
        }
    }

    private fun onControl(op: Byte) {
        when (op) {
            MedallionProtocol.CTRL_START -> {
                if (assembler.isActive) Log.w(TAG, "START while already capturing; restarting utterance")
                assembler.start()
                // Barge-in: the user is speaking again, stop any reply still playing.
                sideKiqqApp.speaker.stop()
                setPhase(MedallionState.Phase.LISTENING)
                armUtteranceTimeout()
            }
            MedallionProtocol.CTRL_END -> finishUtterance()
            MedallionProtocol.CTRL_CANCEL -> {
                assembler.cancel()
                ble.removeCallbacks(utteranceTimeout)
                setPhase(MedallionState.Phase.CONNECTED)
            }
            else -> Log.d(TAG, "Ignoring CONTROL opcode 0x%02x".format(op))
        }
    }

    private fun onAudio(packet: ByteArray) {
        if (!assembler.isActive) {
            // Tolerate a lost START notification: begin capturing at the first audio packet.
            Log.w(TAG, "AUDIO without START; auto-starting utterance")
            assembler.start()
            setPhase(MedallionState.Phase.LISTENING)
        }
        assembler.onAudio(packet)
        armUtteranceTimeout()
    }

    private fun armUtteranceTimeout() {
        ble.removeCallbacks(utteranceTimeout)
        ble.postDelayed(utteranceTimeout, UTTERANCE_IDLE_MS)
    }

    private fun finishUtterance() {
        ble.removeCallbacks(utteranceTimeout)
        val u = assembler.finish() ?: return
        val warning = if (u.stats.degraded) {
            "Audio gaps: ${u.stats.gaps} gap(s), ${u.stats.missingPackets} lost, ${u.stats.outOfOrder} late" +
                (if (u.stats.truncated) ", truncated" else "")
        } else null
        warning?.let { Log.w(TAG, it) }
        _state.update { it.copy(lastAudioWarning = warning) }
        if (!utterances.trySend(u).isSuccess) {
            Log.w(TAG, "Pipeline busy; dropping utterance")
        }
    }

    private fun writeControl(op: Byte) = ble.post {
        val c = controlChar ?: return@post
        queue.enqueue(GattQueue.Op.Write(c, byteArrayOf(op), withResponse = true))
    }

    // ------------------------------------------------------------ pipeline (coroutine)

    private suspend fun process(u: UtteranceAssembler.Utterance) {
        setPhase(MedallionState.Phase.THINKING)
        writeControl(MedallionProtocol.CTRL_THINKING)
        val speaker = sideKiqqApp.speaker
        val output = VoiceOutput { text ->
            setPhase(MedallionState.Phase.SPEAKING)
            speaker.speak(text)
        }
        val outcome = try {
            assistant.handleUtterance(u.pcm, Device.MEDALLION, output)
        } catch (e: Exception) {
            Log.e(TAG, "pipeline failed", e)
            VoiceAssistant.Outcome.Failed(e)
        }
        if (outcome is VoiceAssistant.Outcome.Answered) {
            _state.update { it.copy(lastTranscript = outcome.transcript, lastReply = outcome.response.reply) }
        }
        // 0x11 ends the LED pulse with a short haptic, whatever the outcome.
        writeControl(MedallionProtocol.CTRL_REPLY_DELIVERED)
        setPhase(if (gatt != null) MedallionState.Phase.CONNECTED else MedallionState.Phase.IDLE)
    }

    private fun setPhase(p: MedallionState.Phase) = _state.update { it.copy(phase = p) }

    companion object {
        private const val TAG = "SideKiqqMedallion"
        private const val NOTIFICATION_ID = 41
        private const val ACTION_STOP = "com.sidekiqq.phone.medallion.STOP"
        private const val UTTERANCE_IDLE_MS = 3_000L
        private const val SCAN_WINDOW_MS = 30_000L
        private const val INITIAL_RECONNECT_MS = 2_000L
        private const val MAX_RECONNECT_MS = 60_000L

        private val _state = MutableStateFlow(MedallionState())
        val state: StateFlow<MedallionState> = _state.asStateFlow()

        @Volatile private var instance: MedallionService? = null

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, MedallionService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, MedallionService::class.java).setAction(ACTION_STOP))
        }

        /** CONTROL 0x12 (double haptic). Returns false if no medallion is connected. */
        fun signalNeedsAttention(): Boolean {
            val s = instance ?: return false
            if (s.controlChar == null) return false
            s.writeControl(MedallionProtocol.CTRL_NEEDS_ATTENTION)
            return true
        }

        fun requiredPermissions(): Array<String> =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
            }

        fun hasBlePermissions(context: Context): Boolean = requiredPermissions().all {
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }
    }
}

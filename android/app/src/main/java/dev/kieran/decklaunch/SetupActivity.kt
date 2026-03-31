package dev.kieran.decklaunch

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class SetupActivity : AppCompatActivity() {

    private val prefs by lazy { getSharedPreferences("decklaunch", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        val serverUrlInput = findViewById<EditText>(R.id.server_url_input)
        val tokenInput = findViewById<EditText>(R.id.token_input)
        val saveButton = findViewById<Button>(R.id.save_button)

        // Pre-fill if values already exist (re-configure flow)
        serverUrlInput.setText(prefs.getString("server_url", "http://"))
        tokenInput.setText(prefs.getString("auth_token", ""))

        saveButton.setOnClickListener {
            val url = serverUrlInput.text.toString().trim()
            val token = tokenInput.text.toString().trim()

            if (url.isBlank() || url == "http://") {
                Toast.makeText(this, "Enter a valid server URL", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (token.isBlank()) {
                Toast.makeText(this, "Enter the auth token", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            prefs.edit()
                .putString("server_url", url)
                .putString("auth_token", token)
                .apply()

            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }
    }
}

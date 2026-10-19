package expo.modules.anchorauthorization

import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest

/** Verify identity before an arbitrary HTTPS download reaches the installer.
 * Android's installer remains responsible for cryptographic APK verification.
 */
class WalletUpdateVerificationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WalletUpdateVerification")

    AsyncFunction("verify") { fileUri: String, expectedVersion: Long ->
      val context = appContext.reactContext ?: throw IllegalStateException("Wallet is unavailable")
      val uri = Uri.parse(fileUri)
      require(uri.scheme == "file" && uri.authority.isNullOrEmpty()) { "Invalid update file" }
      val file = File(requireNotNull(uri.path)).canonicalFile
      val cache = context.cacheDir.canonicalFile
      require(file.path.startsWith(cache.path + File.separator) && file.isFile && file.length() > 0) { "Invalid update file" }
      val manager = context.packageManager
      val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
      @Suppress("DEPRECATION")
      val installed = manager.getPackageInfo(context.packageName, flags)
      @Suppress("DEPRECATION")
      val candidate = manager.getPackageArchiveInfo(file.path, flags)
        ?: throw IllegalArgumentException("Invalid update package")
      require(UpdatePackagePolicy.accepts(context.packageName, version(installed), signers(installed),
        candidate.packageName, version(candidate), signers(candidate), expectedVersion)) { "Update package identity mismatch" }
      true
    }
  }

  @Suppress("DEPRECATION")
  private fun version(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    return signatures?.map { signature ->
      MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
    }?.toSet() ?: emptySet()
  }
}

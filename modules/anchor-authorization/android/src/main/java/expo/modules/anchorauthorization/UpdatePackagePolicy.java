package expo.modules.anchorauthorization;

import java.util.Set;

/** Shared native identity policy; APK signature integrity is enforced by Android. */
final class UpdatePackagePolicy {
  static boolean accepts(String installedPackage, long installedVersion, Set<String> installedSigners,
      String candidatePackage, long candidateVersion, Set<String> candidateSigners, long expectedVersion) {
    return installedPackage.equals(candidatePackage)
        && candidateVersion == expectedVersion && candidateVersion > installedVersion
        && !installedSigners.isEmpty() && installedSigners.equals(candidateSigners);
  }
}

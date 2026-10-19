cask "eavesy" do
  version "0.4.0"
  sha256 "b11aeb4dd159935425733e4b9a0f657a30baa94ba7389c0231fd33164da5aebc"

  url "https://eavesy.com/api/downloads/mac/Eavesy_#{version}_aarch64.dmg"
  name "Eavesy"
  desc "Local-first capture tool that turns drops into Markdown context for AI agents"
  homepage "https://eavesy.com/"

  livecheck do
    url "https://eavesy.com/api/updates/darwin/aarch64/0.0.0"
    strategy :json do |json|
      json["version"]
    end
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Eavesy.app"

  # The device token lives in the login Keychain under the services
  # "com.eavesy.desktop.device-token.v2" (and the legacy
  # "com.eavesy.desktop.device-token"). Casks cannot remove Keychain items;
  # delete them in Keychain Access or with `security delete-generic-password -s <service>`.
  # Recordings mirrored to ~/Eavesy are user data and are intentionally kept.
  zap trash: [
    "~/Library/Application Support/com.eavesy.desktop",
    "~/Library/Caches/com.eavesy.desktop",
    "~/Library/HTTPStorages/com.eavesy.desktop",
    "~/Library/Logs/com.eavesy.desktop",
    "~/Library/Preferences/com.eavesy.desktop.plist",
    "~/Library/Saved Application State/com.eavesy.desktop.savedState",
    "~/Library/WebKit/com.eavesy.desktop",
  ]
end

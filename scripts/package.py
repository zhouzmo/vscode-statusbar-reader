"""Create an offline VSIX archive without running or compiling extension code."""

import json
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile


root = Path(__file__).resolve().parents[1]
package = json.loads((root / "package.json").read_text(encoding="utf-8"))
namespace = "http://schemas.microsoft.com/developer/vsx-schema/2011"
ET.register_namespace("", namespace)


def element(parent, tag, attributes=None, text=None):
    node = ET.SubElement(parent, "{" + namespace + "}" + tag, attributes or {})
    node.text = text
    return node


manifest = ET.Element("{" + namespace + "}PackageManifest", {"Version": "2.0.0"})
metadata = element(manifest, "Metadata")
element(metadata, "Identity", {
    "Language": "zh-CN", "Id": package["name"], "Version": package["version"],
    "Publisher": package["publisher"],
})
element(metadata, "DisplayName", text=package["displayName"])
element(metadata, "Description", {"{http://www.w3.org/XML/1998/namespace}space": "preserve"}, package["description"])
element(metadata, "Categories", text="Other")
properties = element(metadata, "Properties")
for key, value in {
    "Microsoft.VisualStudio.Code.Engine": package["engines"]["vscode"],
    "Microsoft.VisualStudio.Code.ExtensionDependencies": "",
    "Microsoft.VisualStudio.Code.ExtensionPack": "",
    "Microsoft.VisualStudio.Code.ExtensionKind": ",".join(package["extensionKind"]),
    "Microsoft.VisualStudio.Code.LocalizedLanguages": "",
    "Microsoft.VisualStudio.Code.EnabledApiProposals": "",
    "Microsoft.VisualStudio.Code.ExecutesCode": "true",
}.items():
    element(properties, "Property", {"Id": key, "Value": value})
targets = element(manifest, "Installation")
element(targets, "InstallationTarget", {"Id": "Microsoft.VisualStudio.Code"})
element(manifest, "Dependencies")
assets = element(manifest, "Assets")
for asset_type, path in [
    ("Microsoft.VisualStudio.Code.Manifest", "package.json"),
    ("Microsoft.VisualStudio.Services.Content.Details", "README.md"),
    ("Microsoft.VisualStudio.Services.Content.License", "LICENSE"),
]:
    element(assets, "Asset", {"Type": asset_type, "Path": "extension/" + path, "Addressable": "true"})

content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="cjs" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Override PartName="/extension/LICENSE" ContentType="text/plain"/>
  <Override PartName="/extension/vendor/fflate-LICENSE" ContentType="text/plain"/>
  <Override PartName="/extension/vendor/sax-LICENSE" ContentType="text/plain"/>
</Types>
'''
output = root / (package["name"] + "-" + package["version"] + ".vsix")
files = [root / name for name in ["package.json", "README.md", "LICENSE"]]
for directory in ["src", "vendor"]:
    files.extend(sorted((root / directory).rglob("*")))
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    archive.writestr("[Content_Types].xml", content_types)
    archive.writestr("extension.vsixmanifest", ET.tostring(manifest, encoding="utf-8", xml_declaration=True))
    for file in files:
        if file.is_file():
            archive.write(file, "extension/" + file.relative_to(root).as_posix())
print(output)

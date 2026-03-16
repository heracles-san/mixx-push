{
  "targets": [
  {
    "target_name": "wasapi_helper",
    "type": "executable",
    "sources": ["native/wasapi-helper.cpp"],
    "include_dirs": [],
    "conditions": [["OS=='win'", {
      "libraries": [
        "-lole32.lib",
        "-loleaut32.lib",
        "-lmmdevapi.lib",
        "-lruntimeobject.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17"],
          "RuntimeLibrary": 0
        },
        "VCLinkerTool": {
          "SubSystem": 1
        }
      }
    }]]
  },
  {
    "target_name": "wasapi_capture",
    "sources": ["native/wasapi_capture.cc"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
    "conditions": [["OS=='win'", {
      "libraries": [
        "-lole32.lib",
        "-loleaut32.lib",
        "-lpsapi.lib",
        "-lpropsys.lib",
        "-lmmdevapi.lib",
        "-lruntimeobject.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }]]
  }]
}

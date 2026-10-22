# MyEsp32 固件

cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# 版本号只维护在 ws_client.h 的 MYESP32_FW 里，构建时自动写进 app 描述符，
# 这样服务器/OTA 页面能直接从镜像里读出可下发版本
file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/components/net/include/ws_client.h" _fw_line REGEX "define MYESP32_FW")
string(REGEX MATCH "\"([0-9]+\.[0-9]+\.[0-9]+)\"" _fw_m "${_fw_line}")
set(PROJECT_VER "${CMAKE_MATCH_1}")
project(myesp32)

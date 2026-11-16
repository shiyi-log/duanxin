cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(wifi_forwarder)

spiffs_create_partition_image(storage web FLASH_IN_PROJECT)

idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES hw net ui audio ble nvs_flash lua_runtime
)

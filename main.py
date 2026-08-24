"""
Ponto de entrada do Google Cloud Functions (2ª geração) pro Vigia.

Reaproveita a mesma lógica de checagem do monitor.py sem duplicar nada —
só troca a forma como o estado é lido/gravado (Cloud Storage em vez de
arquivo local, já que o Cloud Functions não tem disco persistente entre
execuções) e como a execução é disparada (chamada HTTP feita pelo Cloud
Scheduler, em vez de cron do sistema operacional).

A autenticação é feita pelo próprio Google Cloud: a função é publicada com
"--no-allow-unauthenticated", e só o Cloud Scheduler (com a permissão de
invocador) consegue chamá-la. Não tem token nem senha no código.
"""

import functions_framework

import monitor


@functions_framework.http
def vigia_http(request):
    exit_code = monitor.run()
    return (f"Vigia executado (código de saída interno: {exit_code}).", 200)

import os
import requests


def fetch(url):
    return requests.get(url).status_code

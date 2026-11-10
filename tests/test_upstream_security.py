"""A configured upstream must not redirect credentials or cabinet actions."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
import urllib.error
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
import server as s
class UpstreamTests(unittest.TestCase):
    def test_redirect_does_not_forward_bridge_credential(self):
        sink=[]
        class Redirect(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                if self.path=='/sink':sink.append(self.headers.get('X-Api-Key'));self.send_response(200)
                else:self.send_response(302);self.send_header('Location','/sink')
                self.send_header('Content-Length','0');self.end_headers()
        server=ThreadingHTTPServer(('127.0.0.1',0),Redirect)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with patch.object(s,'BRIDGE_URL',f'http://127.0.0.1:{server.server_port}'),patch.object(s,'API_KEY','synthetic-private-key'):
                for method in [lambda:s.bridge('GET','/redirect'),lambda:s.bridge_bytes('/redirect')]:
                    with self.assertRaises(urllib.error.HTTPError):method()
            self.assertEqual(sink,[])
        finally:server.shutdown();server.server_close()
if __name__=='__main__':unittest.main()
